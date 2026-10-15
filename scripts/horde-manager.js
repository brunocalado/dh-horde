import { MODULE_ID } from './constants.js';
import { Config } from './config.js';
import { VisualMarkers } from './visual-markers.js';
import { createHordeCopies, moveHordeTowardTarget } from './horde-executor.js';

// ─────────────────────────────────────────────────────────────────────────────
// HordeManager — Business logic for horde multiplication, movement, stat
//                sync, and automatic leader promotion on token death/deletion.
//
// Every change to a group or to its member tokens runs as a task in one serial
// queue. Concurrent tasks used to overwrite the shared 'groups' setting and
// leave members with different HP; serialising them, and re-reading the group
// at the start of each task, is what keeps the horde consistent.
// ─────────────────────────────────────────────────────────────────────────────

let queue = Promise.resolve();

export class HordeManager {

    /**
     * Runs `task` after every previously enqueued task. A failing task is logged
     * and never blocks the ones after it.
     * @param {() => Promise<any>} task
     * @returns {Promise<any>} Settles with the task's own result
     */
    static enqueue(task) {
        const run = queue.then(task);
        queue = run.catch(err => console.error(`${MODULE_ID} |`, err));
        return run;
    }

    /** Only the active GM reacts to document events, so two connected GMs never both act. */
    static get #isRunner() {
        return game.users.activeGM?.isSelf ?? false;
    }

    /**
     * Registers the member-loss and stat-sync hooks.
     * Called during the Foundry 'ready' hook.
     */
    static init() {
        Hooks.on('deleteToken', (tokenDoc) => {
            if (!HordeManager.#isRunner) return;
            const group = Config.getGroupByTokenId(tokenDoc.id);
            if (group) HordeManager.enqueue(() => HordeManager.#handleMemberLost(group.id, tokenDoc.id));
        });

        // Propagation writes member tokens' delta through Token updates, which
        // fire updateToken but not updateActor, so this only ever sees changes
        // made to a member's actor from outside the module.
        Hooks.on('updateActor', (actorDoc, diff) => {
            if (!HordeManager.#isRunner) return;
            const hp     = diff.system?.resources?.hitPoints?.value;
            const stress = diff.system?.resources?.stress?.value;
            if (hp === undefined && stress === undefined) return;

            // Unlinked copies share one base actor, so the synthetic actor's
            // token is the only way to tell which member changed.
            const tokenId = actorDoc.token?.id;
            const group   = Config.getGroupByTokenId(tokenId);
            if (!group) return;
            HordeManager.enqueue(() => HordeManager.#reconcile(group.id, tokenId, { hp, stress }));
        });
    }

    /**
     * Applies a member's reported hp / stress to the whole horde.
     *
     * In this system, hitPoints.value increasing = taking damage (tokens die),
     * hitPoints.value decreasing = healing (tokens regenerate).
     * When hitPoints.value reaches hitPoints.max the entire horde is destroyed.
     *
     * A report equal to the group's value is already applied and ignored.
     *
     * @param {string} groupId
     * @param {string} sourceTokenId - Member whose actor reported the change
     * @param {{hp?: number, stress?: number}} reported
     * @returns {Promise<void>}
     */
    static async #reconcile(groupId, sourceTokenId, { hp, stress }) {
        const group = Config.getGroup(groupId);
        if (!group) return;

        const change = {};
        if (hp     !== undefined && hp     !== group.hp)     change.hp     = hp;
        if (stress !== undefined && stress !== group.stress) change.stress = stress;
        if (Object.keys(change).length === 0) return;

        const actor = HordeManager.#referenceActor(group, sourceTokenId);
        const maxHp = actor?.system?.resources?.hitPoints?.max;

        if (change.hp !== undefined && maxHp && change.hp >= maxHp) {
            await HordeManager.#destroyEntireHorde(group);
            return;
        }

        const hpDelta = (change.hp ?? group.hp) - group.hp;
        await Config.updateGroup(groupId, change);
        await HordeManager.#propagate(Config.getGroup(groupId));

        if (hpDelta > 0) {
            await HordeManager.#killTokensOnDamage(Config.getGroup(groupId), sourceTokenId, hpDelta);
        } else if (hpDelta < 0) {
            await HordeManager.#regenerateTokensOnHeal(Config.getGroup(groupId), -hpDelta);
        }
    }

    /**
     * The actor whose stat block describes the horde: the reporting member if it
     * still exists, otherwise the leader or any member.
     * @param {object} group
     * @param {string} [preferredTokenId]
     * @returns {Actor|null}
     */
    static #referenceActor(group, preferredTokenId) {
        const tokens = game.scenes.get(group.sceneId)?.tokens;
        return tokens?.get(preferredTokenId)?.actor
            ?? tokens?.get(group.leaderId)?.actor
            ?? group.memberIds.map(id => tokens?.get(id)?.actor).find(Boolean)
            ?? null;
    }

    /**
     * Writes the group's hp and stress into every member that differs, in one
     * batched update of the members' ActorDelta.
     * @param {object} group
     * @returns {Promise<void>}
     */
    static async #propagate(group) {
        const scene = game.scenes.get(group.sceneId);
        if (!scene) return;

        const updates = [];
        for (const id of group.memberIds) {
            const resources = scene.tokens.get(id)?.actor?.system?.resources;
            if (!resources) continue;
            if (resources.hitPoints?.value === group.hp && resources.stress?.value === group.stress) continue;
            updates.push({
                _id: id,
                delta: { system: { resources: {
                    hitPoints: { value: group.hp },
                    stress:    { value: group.stress }
                } } }
            });
        }
        if (updates.length) await scene.updateEmbeddedDocuments('Token', updates);
    }

    /**
     * Destroys the entire horde when hitPoints.value reaches hitPoints.max.
     * Deletes all member tokens and removes the group from storage.
     *
     * @param {object} group - The horde group object
     * @returns {Promise<void>}
     */
    static async #destroyEntireHorde(group) {
        const allIds = [...group.memberIds];

        // Remove group first so deleteToken hooks skip these tokens
        await Config.deleteGroup(group.id);

        const scene = game.scenes.get(group.sceneId);
        const existing = allIds.filter(id => scene?.tokens.has(id));
        if (existing.length > 0) {
            await scene.deleteEmbeddedDocuments('Token', existing);
        }

        VisualMarkers._refreshAll();
        ui.notifications.info(`[${Config.data.modTitle}] Horde destroyed — all ${allIds.length} token(s) eliminated.`);
    }

    /**
     * Removes horde tokens when damage is taken (hitPoints.value increases).
     * For each point of HP marked, `typeData.hordeHP` tokens are deleted.
     * Prioritises the token that received the damage first, then nearest tokens.
     *
     * Updates the group storage before deleting so the `deleteToken` hook
     * finds nothing left to do.
     *
     * @param {object} group          - The horde group object
     * @param {string} sourceTokenId  - Token that received the HP change
     * @param {number} hpMarked       - Positive number of HP points marked (damage)
     * @returns {Promise<void>}
     */
    static async #killTokensOnDamage(group, sourceTokenId, hpMarked) {
        const hordeHp = HordeManager.#referenceActor(group, sourceTokenId)?.system?.typeData?.hordeHP;
        if (!hordeHp || hordeHp <= 0) return;

        const tokensToKill = hpMarked * hordeHp;
        if (tokensToKill <= 0) return;

        // Build candidate list from current group members
        const candidates = group.memberIds
            .map(id => canvas.tokens.get(id))
            .filter(Boolean);

        const origin = canvas.tokens.get(sourceTokenId) ?? canvas.tokens.get(group.leaderId) ?? candidates[0];
        if (!origin) return;

        // Sort: source token first (it took the hit), then by proximity to source
        candidates.sort((a, b) => {
            if (a.id === sourceTokenId) return -1;
            if (b.id === sourceTokenId) return 1;
            const distA = Math.hypot(a.center.x - origin.center.x, a.center.y - origin.center.y);
            const distB = Math.hypot(b.center.x - origin.center.x, b.center.y - origin.center.y);
            return distA - distB;
        });

        const killCount = Math.min(tokensToKill, candidates.length);
        const killIds   = new Set(candidates.slice(0, killCount).map(t => t.id));

        if (killIds.size === 0) return;

        // Update group storage first so the deleteToken hook skips these tokens
        const remainingIds = group.memberIds.filter(id => !killIds.has(id));

        if (remainingIds.length === 0) {
            await Config.deleteGroup(group.id);
        } else {
            const updates = { memberIds: remainingIds };
            if (killIds.has(group.leaderId)) {
                updates.leaderId = remainingIds[0];
            }
            await Config.updateGroup(group.id, updates);
        }

        // Delete the tokens from the canvas
        await canvas.scene.deleteEmbeddedDocuments('Token', [...killIds]);

        VisualMarkers._refreshAll();
    }

    /**
     * Regenerates horde tokens when healing occurs (hitPoints.value decreases).
     * For each point of HP unmarked, `typeData.hordeHP` tokens are spawned near
     * the leader, up to the maximum horde size (hordeHp * hitPoints.max).
     *
     * @param {object} group          - The horde group object
     * @param {number} hpHealed       - Positive number of HP points unmarked (healed)
     * @returns {Promise<void>}
     */
    static async #regenerateTokensOnHeal(group, hpHealed) {
        const actor   = HordeManager.#referenceActor(group, group.leaderId);
        const hordeHp = actor?.system?.typeData?.hordeHP;
        if (!hordeHp || hordeHp <= 0) return;

        const maxHp       = actor.system?.resources?.hitPoints?.max;
        const maxTokens   = hordeHp * maxHp;
        const currentSize = group.memberIds.length;

        // Cap regeneration so horde never exceeds its maximum size
        const rawRegen    = hpHealed * hordeHp;
        const tokensToAdd = Math.min(rawRegen, maxTokens - currentSize);
        if (tokensToAdd <= 0) return;

        // Use the leader (or any surviving member) as the reference for cloning
        const refToken = canvas.tokens.get(group.leaderId)
            ?? group.memberIds.map(id => canvas.tokens.get(id)).find(Boolean);
        if (!refToken) return;

        // Pass existing member IDs so the spiral skips occupied cells
        // instead of treating them as blocked
        const excludeIds = new Set(group.memberIds);
        const newIds = await createHordeCopies(refToken, tokensToAdd, excludeIds);

        if (newIds.length > 0) {
            const current = Config.getGroup(group.id);
            if (!current) return;
            await Config.updateGroup(group.id, { memberIds: [...current.memberIds, ...newIds] });
            VisualMarkers._refreshAll();
        }
    }

    /**
     * Multiplies a horde token into individual copies.
     *
     * Before creating copies, ensures the origin token has actorLink: false
     * so all copies (which inherit baseData) are also unlinked from the actor.
     *
     * Reads typeData.hordeHP and the current remaining HP from the actor,
     * creates copies in a spiral pattern so the group totals (hordeHp * remainingHp) tokens
     * including the origin, and forms a horde group.
     * Remaining HP = hitPoints.max - hitPoints.value (inverted tracking: value increases with damage).
     * @param {Token} token - The original horde token
     * @returns {Promise<void>}
     */
    static multiplyHorde(token) {
        return HordeManager.enqueue(async () => {
            const actor = token.actor;
            if (!actor) {
                ui.notifications.warn(`[${Config.data.modTitle}] Token has no linked actor.`);
                return;
            }

            const hordeHp    = actor.system?.typeData?.hordeHP;
            const maxHp      = actor.system?.resources?.hitPoints?.max;
            const currentHp  = actor.system?.resources?.hitPoints?.value ?? 0;
            const stress     = actor.system?.resources?.stress?.value ?? 0;
            const remaining  = maxHp - currentHp;

            if (!hordeHp || !maxHp) {
                ui.notifications.warn(`[${Config.data.modTitle}] Token actor is missing hordeHP or hitPoints.max values.`);
                return;
            }

            const count = hordeHp * remaining;
            if (count <= 0) {
                ui.notifications.warn(`[${Config.data.modTitle}] Computed horde count is 0 or negative.`);
                return;
            }

            // Unlink the origin token from its actor before multiplying so all
            // copies (which clone baseData) are also unlinked.
            if (token.document.actorLink !== false) {
                await token.document.update({ actorLink: false });
            }

            // The origin token is one of the horde's members, so only count - 1 copies
            // are needed; this keeps the initial size equal to the regeneration cap.
            const copies = count - 1;
            ui.notifications.info(`[${Config.data.modTitle}] Creating ${copies} horde tokens...`);

            const newIds = await createHordeCopies(token, copies);

            if (copies > 0 && newIds.length === 0) {
                ui.notifications.warn(`[${Config.data.modTitle}] Could not place any horde copies.`);
                return;
            }

            const allMemberIds = [token.id, ...newIds];
            await Config.createGroup({
                sceneId: token.document.parent.id,
                leaderId: token.id,
                memberIds: allMemberIds,
                hp: currentHp,
                stress
            });

            VisualMarkers._refreshAll();
            ui.notifications.info(`[${Config.data.modTitle}] Horde created with ${allMemberIds.length} tokens.`);
        });
    }

    /**
     * Moves all tokens in a horde group toward the GM's currently targeted token(s).
     * @param {Token} token - Any token belonging to the horde group
     * @param {'close'|'far'|'all'} mode - Movement range mode
     * @returns {Promise<void>}
     */
    static async moveHorde(token, mode) {
        const group = Config.getGroupByTokenId(token.id);
        if (!group) {
            ui.notifications.warn(`[${Config.data.modTitle}] Token is not part of a horde group.`);
            return;
        }

        const targets = [...game.user.targets];
        if (targets.length === 0) {
            ui.notifications.warn(`[${Config.data.modTitle}] Select a target token first.`);
            return;
        }

        const memberTokens = group.memberIds
            .map(id => canvas.tokens.get(id))
            .filter(Boolean);

        if (memberTokens.length === 0) {
            ui.notifications.warn(`[${Config.data.modTitle}] No horde members found on canvas.`);
            return;
        }

        await moveHordeTowardTarget(memberTokens, targets, mode);
    }

    /**
     * Dissolves a horde group: deletes all member tokens except the leader,
     * then removes the group from storage. The leader token remains on the canvas.
     * @param {string} groupId
     * @returns {Promise<number|null>} Number of tokens removed, or null if the group is gone
     */
    static dissolveGroup(groupId) {
        return HordeManager.enqueue(async () => {
            const group = Config.getGroup(groupId);
            if (!group) return null;

            // Remove the group first so the deleteToken hooks find nothing to do.
            await Config.deleteGroup(group.id);

            const scene = game.scenes.get(group.sceneId);
            const memberIdsToDelete = group.memberIds.filter(id => id !== group.leaderId && scene?.tokens.has(id));
            if (memberIdsToDelete.length > 0) {
                await scene.deleteEmbeddedDocuments('Token', memberIdsToDelete);
            }

            VisualMarkers._refreshAll();
            ui.notifications.info(
                `[${Config.data.modTitle}] Horde dissolved — ${memberIdsToDelete.length} token(s) removed, leader remains.`
            );
            return memberIdsToDelete.length;
        });
    }

    /**
     * Dissolves the horde group a token belongs to.
     * @param {Token} token - Any token belonging to the horde group
     * @returns {Promise<void>}
     */
    static async dissolveHorde(token) {
        const group = Config.getGroupByTokenId(token.id);
        if (!group) {
            ui.notifications.warn(`[${Config.data.modTitle}] Token is not part of a horde group.`);
            return;
        }
        await HordeManager.dissolveGroup(group.id);
    }

    /**
     * Makes a member the group's leader.
     * @param {string} groupId
     * @param {string} memberId
     * @returns {Promise<void>}
     */
    static promoteLeader(groupId, memberId) {
        return HordeManager.enqueue(async () => {
            const group = Config.getGroup(groupId);
            if (!group?.memberIds.includes(memberId)) return;
            await Config.updateGroup(groupId, { leaderId: memberId });
            VisualMarkers._refreshAll();
            const leaderName = Config.resolveTokenName(group.sceneId, memberId);
            ui.notifications.info(`[${Config.data.modTitle}] ${leaderName} promoted to horde leader.`);
        });
    }

    /**
     * Removes a member from its group without deleting the token.
     * @param {string} groupId
     * @param {string} memberId
     * @returns {Promise<void>}
     */
    static removeMember(groupId, memberId) {
        return HordeManager.enqueue(async () => {
            await HordeManager.#handleMemberLost(groupId, memberId, { quiet: true });
            VisualMarkers._refreshAll();
        });
    }

    /**
     * Handles a horde member being lost (deleted, killed, or removed).
     * Removes the member from the group, promotes a new leader if needed,
     * or destroys the group if no members remain.
     * @param {string} groupId
     * @param {string} lostTokenId - ID of the lost token
     * @param {{quiet?: boolean}} [options] - Skip the notifications
     * @returns {Promise<void>}
     */
    static async #handleMemberLost(groupId, lostTokenId, { quiet = false } = {}) {
        const group = Config.getGroup(groupId);
        if (!group?.memberIds.includes(lostTokenId)) return;

        const updatedMemberIds = group.memberIds.filter(id => id !== lostTokenId);

        // No members left — destroy the group entirely
        if (updatedMemberIds.length === 0) {
            await Config.deleteGroup(group.id);
            VisualMarkers._refreshAll();
            if (!quiet) ui.notifications.info(`[${Config.data.modTitle}] Horde group destroyed — no members remain.`);
            return;
        }

        // Leader was lost — promote the next member
        if (lostTokenId === group.leaderId) {
            const newLeaderId = updatedMemberIds[0];
            await Config.updateGroup(group.id, {
                leaderId: newLeaderId,
                memberIds: updatedMemberIds
            });
            VisualMarkers._refreshAll();
            if (!quiet) {
                const leaderName = Config.resolveTokenName(group.sceneId, newLeaderId);
                ui.notifications.info(`[${Config.data.modTitle}] ${leaderName} promoted to horde leader.`);
            }
            return;
        }

        // Regular member lost — just update the member list
        await Config.updateGroup(group.id, { memberIds: updatedMemberIds });
    }
}
