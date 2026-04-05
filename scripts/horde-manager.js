import { Config } from './config.js';
import { VisualMarkers } from './visual-markers.js';
import { createHordeCopies, moveHordeTowardTarget } from './horde-executor.js';

// ─────────────────────────────────────────────────────────────────────────────
// HordeManager — Business logic for horde multiplication, movement, and
//                automatic leader promotion on token death/deletion.
// ─────────────────────────────────────────────────────────────────────────────

// Prevents re-entrant sync loops when propagating stat changes.
let _syncingHorde = false;

export class HordeManager {

    /**
     * Registers auto-promotion hooks for leader death/deletion,
     * and stat synchronisation (hp / stress) across all horde members.
     * Called during the Foundry 'ready' hook.
     */
    static init() {
        // When a token is deleted, remove it from its horde group and promote if needed
        Hooks.on('deleteToken', (tokenDoc, _options, _userId) => {
            if (!game.user.isGM) return;
            const group = Config.getGroupByTokenId(tokenDoc.id);
            if (group) HordeManager._handleMemberLost(group, tokenDoc.id);
        });

        // Shared updateActor handler: stat sync and horde size management.
        Hooks.on('updateActor', (actorDoc, diff, _options, _userId) => {
            if (!game.user.isGM) return;

            // Skip if we are the ones triggering the propagation
            if (!_syncingHorde) {
                HordeManager._syncStatToGroup(actorDoc, diff);
            }
        });
    }

    /**
     * Propagates hitPoints.value and/or stress.value changes from one horde
     * member's actor to all other members in the same group.
     *
     * In this system, hitPoints.value increasing = taking damage (tokens die),
     * hitPoints.value decreasing = healing (tokens regenerate).
     * When hitPoints.value reaches hitPoints.max the entire horde is destroyed.
     *
     * Only fires when the changed actor belongs to a horde group. Uses
     * `_syncingHorde` to break the re-entrant update loop.
     *
     * @param {Actor} actorDoc - The actor that just changed
     * @param {object} diff    - The update diff object
     */
    static async _syncStatToGroup(actorDoc, diff) {
        const hp     = diff.system?.resources?.hitPoints?.value;
        const stress = diff.system?.resources?.stress?.value;

        // Nothing to sync
        if (hp === undefined && stress === undefined) return;

        // For unlinked tokens, actorDoc.token references the owning TokenDocument.
        // This is the only reliable way to identify the source token since all
        // unlinked copies share the same base actorId.
        const sourceTokenDoc = actorDoc.token;
        if (!sourceTokenDoc) return;

        const group = Config.getGroupByTokenId(sourceTokenDoc.id);
        if (!group) return;

        // Capture old HP from a sibling member before syncing, so we can
        // calculate the HP delta for the token-kill / regenerate feature.
        let oldHp = null;
        if (hp !== undefined) {
            for (const memberId of group.memberIds) {
                if (memberId === sourceTokenDoc.id) continue;
                const siblingDoc = canvas.scene?.tokens?.get(memberId);
                if (siblingDoc?.actor) {
                    oldHp = siblingDoc.actor.system?.resources?.hitPoints?.value;
                    break;
                }
            }
        }

        // Build the update payload
        const updateData = {};
        if (hp     !== undefined) updateData['system.resources.hitPoints.value'] = hp;
        if (stress !== undefined) updateData['system.resources.stress.value']    = stress;

        _syncingHorde = true;
        try {
            // Update every other member's synthetic actor via tokenDoc.actor,
            // which targets the unlinked token's own ActorDelta — not the base actor.
            const updates = [];
            for (const memberId of group.memberIds) {
                if (memberId === sourceTokenDoc.id) continue;
                const tokenDoc = canvas.scene?.tokens?.get(memberId);
                if (!tokenDoc?.actor) continue;
                updates.push(tokenDoc.actor.update(updateData));
            }
            await Promise.all(updates);
        } finally {
            _syncingHorde = false;
        }

        // Adjust horde size based on HP change direction
        if (hp !== undefined && oldHp !== null) {
            const maxHp = sourceTokenDoc.actor?.system?.resources?.hitPoints?.max;

            // HP reached max — total horde wipe
            if (hp >= maxHp) {
                await HordeManager._destroyEntireHorde(group);
            }
            // HP increased — damage taken, kill tokens
            else if (hp > oldHp) {
                await HordeManager._killTokensOnDamage(group, sourceTokenDoc, hp - oldHp);
            }
            // HP decreased — healing, regenerate tokens
            else if (hp < oldHp) {
                await HordeManager._regenerateTokensOnHeal(group, sourceTokenDoc, oldHp - hp);
            }
        }
    }

    /**
     * Destroys the entire horde when hitPoints.value reaches hitPoints.max.
     * Deletes all member tokens and removes the group from storage.
     *
     * @param {object} group - The horde group object
     * @returns {Promise<void>}
     */
    static async _destroyEntireHorde(group) {
        const allIds = [...group.memberIds];

        // Remove group first so deleteToken hooks skip these tokens
        await Config.deleteGroup(group.id);

        if (allIds.length > 0) {
            await canvas.scene.deleteEmbeddedDocuments('Token', allIds);
        }

        VisualMarkers._refreshAll();
        ui.notifications.info(`[${Config.data.modTitle}] Horde destroyed — all ${allIds.length} token(s) eliminated.`);
    }

    /**
     * Removes horde tokens when damage is taken (hitPoints.value increases).
     * For each point of HP marked, `system.hordeHp` tokens are deleted.
     * Prioritises the token that received the damage first, then nearest tokens.
     *
     * Updates the group storage before deleting so the `deleteToken` hook
     * does not trigger redundant `_handleMemberLost` calls.
     *
     * @param {object} group          - The horde group object
     * @param {TokenDocument} sourceTokenDoc - Token that received the HP change
     * @param {number} hpMarked       - Positive number of HP points marked (damage)
     * @returns {Promise<void>}
     */
    static async _killTokensOnDamage(group, sourceTokenDoc, hpMarked) {
        const hordeHp = sourceTokenDoc.actor?.system?.hordeHp;
        if (!hordeHp || hordeHp <= 0) return;

        const tokensToKill = hpMarked * hordeHp;
        if (tokensToKill <= 0) return;

        const sourceToken = canvas.tokens.get(sourceTokenDoc.id);
        if (!sourceToken) return;

        // Build candidate list from current group members
        const candidates = group.memberIds
            .map(id => canvas.tokens.get(id))
            .filter(Boolean);

        // Sort: source token first (it took the hit), then by proximity to source
        candidates.sort((a, b) => {
            if (a.id === sourceTokenDoc.id) return -1;
            if (b.id === sourceTokenDoc.id) return 1;
            const distA = Math.hypot(a.center.x - sourceToken.center.x, a.center.y - sourceToken.center.y);
            const distB = Math.hypot(b.center.x - sourceToken.center.x, b.center.y - sourceToken.center.y);
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
     * For each point of HP unmarked, `system.hordeHp` tokens are spawned near
     * the leader, up to the maximum horde size (hordeHp * hitPoints.max).
     *
     * @param {object} group          - The horde group object
     * @param {TokenDocument} sourceTokenDoc - Token that received the HP change
     * @param {number} hpHealed       - Positive number of HP points unmarked (healed)
     * @returns {Promise<void>}
     */
    static async _regenerateTokensOnHeal(group, sourceTokenDoc, hpHealed) {
        const actor   = sourceTokenDoc.actor;
        const hordeHp = actor?.system?.hordeHp;
        if (!hordeHp || hordeHp <= 0) return;

        const maxHp       = actor.system?.resources?.hitPoints?.max;
        const maxTokens   = hordeHp * maxHp;
        const currentSize = group.memberIds.length;

        // Cap regeneration so horde never exceeds its maximum size
        const rawRegen    = hpHealed * hordeHp;
        const tokensToAdd = Math.min(rawRegen, maxTokens - currentSize);
        if (tokensToAdd <= 0) return;

        // Use the leader (or any surviving member) as the reference for cloning
        const refTokenDoc = canvas.scene?.tokens?.get(group.leaderId)
            ?? canvas.scene?.tokens?.get(group.memberIds[0]);
        if (!refTokenDoc) return;

        const refToken = canvas.tokens.get(refTokenDoc.id);
        if (!refToken) return;

        // Pass existing member IDs so the spiral skips occupied cells
        // instead of treating them as blocked
        const excludeIds = new Set(group.memberIds);
        const newIds = await createHordeCopies(refToken, tokensToAdd, excludeIds);

        if (newIds.length > 0) {
            const updatedMembers = [...group.memberIds, ...newIds];
            await Config.updateGroup(group.id, { memberIds: updatedMembers });
            VisualMarkers._refreshAll();
        }
    }

    /**
     * Multiplies a horde token into individual copies.
     *
     * Before creating copies, ensures the origin token has actorLink: false
     * so all copies (which inherit baseData) are also unlinked from the actor.
     *
     * Reads system.hordeHp and system.resources.hitPoints.max from the actor,
     * creates (hordeHp * hitPoints.max) copies in a spiral pattern, and forms a horde group.
     * @param {Token} token - The original horde token
     * @returns {Promise<void>}
     */
    static async multiplyHorde(token) {
        const actor = token.actor;
        if (!actor) {
            ui.notifications.warn(`[${Config.data.modTitle}] Token has no linked actor.`);
            return;
        }

        const hordeHp = actor.system?.hordeHp;
        const maxHp   = actor.system?.resources?.hitPoints?.max;

        if (!hordeHp || !maxHp) {
            ui.notifications.warn(`[${Config.data.modTitle}] Token actor is missing hordeHp or hitPoints.max values.`);
            return;
        }

        const count = hordeHp * maxHp;
        if (count <= 0) {
            ui.notifications.warn(`[${Config.data.modTitle}] Computed horde count is 0 or negative.`);
            return;
        }

        // Unlink the origin token from its actor before multiplying so all
        // copies (which clone baseData) are also unlinked.
        if (token.document.actorLink !== false) {
            await token.document.update({ actorLink: false });
        }

        ui.notifications.info(`[${Config.data.modTitle}] Creating ${count} horde tokens...`);

        const newIds = await createHordeCopies(token, count);

        if (newIds.length === 0) {
            ui.notifications.warn(`[${Config.data.modTitle}] Could not place any horde copies.`);
            return;
        }

        const allMemberIds = [token.id, ...newIds];
        await Config.createGroup({
            sceneId: canvas.scene.id,
            leaderId: token.id,
            memberIds: allMemberIds
        });

        VisualMarkers._refreshAll();
        ui.notifications.info(`[${Config.data.modTitle}] Horde created with ${allMemberIds.length} tokens.`);
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
     * @param {Token} token - Any token belonging to the horde group
     * @returns {Promise<void>}
     */
    static async dissolveHorde(token) {
        const group = Config.getGroupByTokenId(token.id);
        if (!group) {
            ui.notifications.warn(`[${Config.data.modTitle}] Token is not part of a horde group.`);
            return;
        }

        const memberIdsToDelete = group.memberIds.filter(id => id !== group.leaderId);

        if (memberIdsToDelete.length > 0) {
            await canvas.scene.deleteEmbeddedDocuments('Token', memberIdsToDelete);
        }

        await Config.deleteGroup(group.id);
        VisualMarkers._refreshAll();

        ui.notifications.info(
            `[${Config.data.modTitle}] Horde dissolved — ${memberIdsToDelete.length} token(s) removed, leader remains.`
        );
    }

    /**
     * Handles a horde member being lost (deleted or killed).
     * Removes the member from the group, promotes a new leader if needed,
     * or destroys the group if no members remain.
     * @param {object} group - The horde group object
     * @param {string} lostTokenId - ID of the lost token
     * @returns {Promise<void>}
     */
    static async _handleMemberLost(group, lostTokenId) {
        const updatedMemberIds = group.memberIds.filter(id => id !== lostTokenId);

        // No members left — destroy the group entirely
        if (updatedMemberIds.length === 0) {
            await Config.deleteGroup(group.id);
            VisualMarkers._refreshAll();
            ui.notifications.info(`[${Config.data.modTitle}] Horde group destroyed — no members remain.`);
            return;
        }

        // Leader was lost — promote the next member
        if (lostTokenId === group.leaderId) {
            const newLeaderId = updatedMemberIds[0];
            await Config.updateGroup(group.id, {
                leaderId: newLeaderId,
                memberIds: updatedMemberIds
            });
            const leaderName = Config.resolveTokenName(group.sceneId, newLeaderId);
            VisualMarkers._refreshAll();
            ui.notifications.info(`[${Config.data.modTitle}] ${leaderName} promoted to horde leader.`);
            return;
        }

        // Regular member lost — just update the member list
        await Config.updateGroup(group.id, { memberIds: updatedMemberIds });
    }
}
