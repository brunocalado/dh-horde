import { MODULE_ID } from './constants.js';
import { Config } from './config.js';
import { HordeManager } from './horde-manager.js';
import { VisualMarkers } from './visual-markers.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Dashboard — AppV2-based singleton window for managing horde groups.
 * Shows active horde groups with leader info, member count, and actions
 * for finding, expanding, promoting, removing, and dissolving groups.
 */
export class Dashboard extends HandlebarsApplicationMixin(ApplicationV2) {

    /** @type {Dashboard|null} Singleton instance */
    static #instance;

    /** @type {Set<string>} Tracks which group panels are currently expanded */
    #expandedGroups = new Set();

    static DEFAULT_OPTIONS = {
        id: "dh-horde-dashboard-window",
        classes: [MODULE_ID, "dh-horde-dashboard-app"],
        window: {
            title: "DHHORDE.Dashboard.Title",
            resizable: true
        },
        position: { width: 560, height: 400 },
        actions: {
            findLeader:    Dashboard.#onFindLeader,
            expand:        Dashboard.#onExpand,
            dissolve:      Dashboard.#onDissolve,
            promoteLeader: Dashboard.#onPromoteLeader,
            removeMember:  Dashboard.#onRemoveMember
        }
    };

    static PARTS = {
        main: { template: "modules/dh-horde/templates/dashboard.hbs" }
    };

    /**
     * Exposes Dashboard globally for HUD dialog and macro access.
     * Called during the Foundry 'ready' hook via main.js.
     */
    static init() {
        window.HordeDashboard = Dashboard;
    }

    /**
     * Opens the Dashboard window as a singleton. GM only.
     */
    static async open() {
        if (!game.user.isGM) {
            ui.notifications.warn(`[${Config.data.modTitle}] ${game.i18n.localize("DHHORDE.Dashboard.GMOnly")}`);
            return;
        }
        if (!Dashboard.#instance) Dashboard.#instance = new Dashboard();
        Dashboard.#instance.render(true);
    }

    // -----------------------------------------
    // DATA PREPARATION
    // -----------------------------------------

    async _prepareContext() {
        const groups = Config.getGroups().map((g, i) => {
            const groupIndex = i + 1;
            const leaderName = Config.resolveTokenName(g.sceneId, g.leaderId);
            const sceneName = game.scenes.get(g.sceneId)?.name ?? game.i18n.localize('DHHORDE.Common.UnknownScene');
            const members = g.memberIds.map(id => ({
                id,
                name: Config.resolveTokenName(g.sceneId, id),
                isLeader: id === g.leaderId
            }));

            return {
                id: g.id,
                groupIndex,
                leaderName,
                sceneName,
                memberCount: g.memberIds.length,
                members
            };
        });
        return { groups };
    }

    // -----------------------------------------
    // RENDER LIFECYCLE
    // -----------------------------------------

    /**
     * Post-render hook — restores expanded group panels.
     * @param {object} context - prepared template data
     * @param {object} options - render options
     */
    _onRender(context, options) {
        super._onRender(context, options);

        const collapseLabel = game.i18n.localize('DHHORDE.Dashboard.Collapse');
        for (const groupId of this.#expandedGroups) {
            const list = this.element.querySelector(`.dh-members-list[data-group-id="${groupId}"]`);
            const btn  = this.element.querySelector(`[data-action="expand"][data-group-id="${groupId}"]`);
            if (list) list.removeAttribute('hidden');
            if (btn)  btn.innerHTML = `<i class="fas fa-users"></i> ${collapseLabel}`;
        }
    }

    // -----------------------------------------
    // ACTION HANDLERS
    // -----------------------------------------

    static async #onFindLeader(event, target) {
        const groupId = target.dataset.groupId;
        const group = Config.getGroup(groupId);
        if (!group) return;

        const token = canvas?.tokens?.get(group.leaderId);
        if (!token) {
            ui.notifications.warn(`[${Config.data.modTitle}] ${game.i18n.localize("DHHORDE.Dashboard.LeaderNotFound")}`);
            return;
        }
        canvas.animatePan({ x: token.x, y: token.y, scale: Math.max(canvas.stage.scale.x, 1) });
        token.control({ releaseOthers: true });
    }

    static async #onExpand(event, target) {
        const groupId = target.dataset.groupId;
        const wrapper = target.closest('.dh-group-wrapper');
        const memberList = wrapper?.querySelector('.dh-members-list');
        if (!memberList) return;

        const isHidden = memberList.hasAttribute('hidden');
        if (isHidden) {
            memberList.removeAttribute('hidden');
            target.innerHTML = `<i class="fas fa-users"></i> ${game.i18n.localize('DHHORDE.Dashboard.Collapse')}`;
            this.#expandedGroups.add(groupId);
        } else {
            memberList.setAttribute('hidden', '');
            target.innerHTML = `<i class="fas fa-users"></i> ${game.i18n.localize('DHHORDE.Dashboard.Members')}`;
            this.#expandedGroups.delete(groupId);
        }
    }

    /**
     * Dissolves a horde group after confirmation.
     * Deletes all member tokens except the leader, then removes the group.
     */
    static async #onDissolve(event, target) {
        const groupId = target.dataset.groupId;
        const group   = Config.getGroup(groupId);
        if (!group) return;

        const leaderName = Config.resolveTokenName(group.sceneId, group.leaderId);
        const confirmed  = await foundry.applications.api.DialogV2.confirm({
            window:  { title: game.i18n.localize('DHHORDE.Dashboard.DissolveTitle') },
            content: `<p>${game.i18n.format('DHHORDE.Dashboard.DissolveConfirm', { leader: foundry.utils.escapeHTML(leaderName) })}</p>`
        });

        if (!confirmed) return;

        // Delete all member tokens except the leader
        const memberIdsToDelete = group.memberIds.filter(id => id !== group.leaderId);
        if (memberIdsToDelete.length > 0) {
            await canvas.scene.deleteEmbeddedDocuments('Token', memberIdsToDelete);
        }

        await Config.deleteGroup(groupId);
        VisualMarkers._refreshAll();

        ui.notifications.info(`[${Config.data.modTitle}] ${game.i18n.format("DHHORDE.Manager.Dissolved", { count: memberIdsToDelete.length })}`);
        this.render(true);
    }

    static async #onPromoteLeader(event, target) {
        const memberId = target.dataset.memberId;
        const groupId  = target.dataset.groupId;
        const group    = Config.getGroup(groupId);
        if (!group) return;

        await Config.updateGroup(groupId, { leaderId: memberId });
        VisualMarkers._refreshAll();

        const newLeaderName = Config.resolveTokenName(group.sceneId, memberId);
        ui.notifications.info(`[${Config.data.modTitle}] ${game.i18n.format("DHHORDE.Dashboard.Promoted", { name: newLeaderName })}`);
        this.render(true);
    }

    static async #onRemoveMember(event, target) {
        const memberId = target.dataset.memberId;
        const groupId  = target.dataset.groupId;
        const group    = Config.getGroup(groupId);
        if (!group) return;

        const updatedMembers = group.memberIds.filter(id => id !== memberId);

        if (memberId === group.leaderId) {
            if (updatedMembers.length === 0) {
                await Config.deleteGroup(groupId);
            } else {
                await Config.updateGroup(groupId, {
                    leaderId: updatedMembers[0],
                    memberIds: updatedMembers
                });
            }
        } else {
            await Config.updateGroup(groupId, { memberIds: updatedMembers });
        }

        VisualMarkers._refreshAll();
        this.render(true);
    }
}
