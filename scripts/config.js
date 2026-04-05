const MOD_ID = "dh-horde";
const MOD_PATH = `/modules/${MOD_ID}`;
const MOD_TITLE = "DH Horde";

// ─────────────────────────────────────────────────────────────────────────────
// HordeGroupDataModel — schema validation for each horde group entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the shape of a single horde group stored in the 'groups' world setting.
 * Each group maps a leader token to its horde member tokens via Foundry document IDs.
 */
class HordeGroupDataModel extends foundry.abstract.DataModel {
    /** @returns {object} */
    static defineSchema() {
        const fields = foundry.data.fields;
        return {
            id:        new fields.StringField({ required: true, blank: false }),
            sceneId:   new fields.StringField({ required: true, blank: false }),
            leaderId:  new fields.StringField({ initial: '' }),
            memberIds: new fields.ArrayField(new fields.StringField())
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HordeDashboardMenu — shell that immediately opens the Dashboard
// ─────────────────────────────────────────────────────────────────────────────
class HordeDashboardMenu extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: "dh-horde-dashboard-shell",
        window: { title: MOD_TITLE }
    };
    async _renderHTML()  { return null; }
    async _replaceHTML() {}

    /**
     * Immediately closes the shell and opens the Dashboard.
     * Triggered by the Foundry settings menu button.
     */
    async _onRender(_ctx, _opts) {
        this.close({ animate: false });
        window.HordeDashboard?.open();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
export class Config {
    static data = {
        modID: MOD_ID,
        modPath: MOD_PATH,
        modTitle: MOD_TITLE
    };

    /** @type {boolean} Set to true by bootstrap after all prerequisites are ready */
    static ready = false;

    /**
     * Registers all module settings and menus.
     * Called during the Foundry 'setup' hook.
     */
    static init() {

        // ── Menu: Horde Dashboard ─────────────────────────────────────────
        game.settings.registerMenu(MOD_ID, 'hordeDashboard', {
            name: 'Horde Dashboard',
            label: 'Manage Hordes',
            hint: 'View and manage active horde groups.',
            icon: 'fas fa-chess-rook',
            type: HordeDashboardMenu,
            restricted: true
        });

        // ── Single array setting for all horde group data ─────────────────
        game.settings.register(MOD_ID, 'groups', {
            name: 'Horde Groups',
            hint: 'Internal storage for horde group data.',
            scope: 'world',
            config: false,
            type: Array,
            default: []
        });

        // ── Movement distance settings ────────────────────────────────────
        game.settings.register(MOD_ID, 'closeMoveDistance', {
            name: 'Close Move Distance',
            hint: 'Number of grid squares for Close movement (default 6 = 30 ft).',
            scope: 'world',
            config: true,
            type: Number,
            default: 6,
            range: { min: 1, max: 30, step: 1 }
        });

        game.settings.register(MOD_ID, 'farMoveDistance', {
            name: 'Far Move Distance',
            hint: 'Number of grid squares for Far movement (default 12 = 60 ft).',
            scope: 'world',
            config: true,
            type: Number,
            default: 12,
            range: { min: 1, max: 60, step: 1 }
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Group CRUD helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Returns all stored horde groups, removing any whose scene no longer exists.
     * @returns {object[]}
     */
    static getGroups() {
        const raw = game.settings.get(MOD_ID, 'groups') ?? [];
        const cleaned = raw.filter(g => game.scenes.get(g.sceneId));
        if (cleaned.length !== raw.length) {
            game.settings.set(MOD_ID, 'groups', cleaned);
        }
        return cleaned;
    }

    /**
     * Overwrites the entire groups array in settings.
     * @param {object[]} groups
     * @returns {Promise<void>}
     */
    static async saveGroups(groups) {
        await game.settings.set(MOD_ID, 'groups', groups);
    }

    /**
     * Finds a single group by its stable unique ID.
     * @param {string} id
     * @returns {object|null}
     */
    static getGroup(id) {
        return Config.getGroups().find(g => g.id === id) ?? null;
    }

    /**
     * Finds the horde group that contains a given token (as leader or member).
     * @param {string} tokenId - Token document ID
     * @returns {object|null} The group object, or null if token is not in any group
     */
    static getGroupByTokenId(tokenId) {
        if (!tokenId) return null;
        const groups = Config.getGroups();
        for (const g of groups) {
            if (g.leaderId === tokenId) return g;
            if (g.memberIds.includes(tokenId)) return g;
        }
        return null;
    }

    /**
     * Creates a new horde group entry and persists it.
     * Generates a stable unique ID via foundry.utils.randomID().
     * @param {object} data - { sceneId, leaderId, memberIds }
     * @returns {Promise<object>} The newly created group object
     */
    static async createGroup(data) {
        const group = {
            id: foundry.utils.randomID(),
            sceneId: data.sceneId,
            leaderId: data.leaderId ?? '',
            memberIds: data.memberIds ?? []
        };
        new HordeGroupDataModel(group);
        const groups = Config.getGroups();
        groups.push(group);
        await Config.saveGroups(groups);
        return group;
    }

    /**
     * Merges a delta object into an existing group identified by ID.
     * @param {string} id - Group ID
     * @param {object} delta - Fields to merge (e.g. { leaderId, memberIds })
     * @returns {Promise<void>}
     */
    static async updateGroup(id, delta) {
        const groups = Config.getGroups();
        const idx = groups.findIndex(g => g.id === id);
        if (idx === -1) return;
        Object.assign(groups[idx], delta);
        new HordeGroupDataModel(groups[idx]);
        await Config.saveGroups(groups);
    }

    /**
     * Removes a group by ID.
     * @param {string} id
     * @returns {Promise<void>}
     */
    static async deleteGroup(id) {
        const groups = Config.getGroups().filter(g => g.id !== id);
        await Config.saveGroups(groups);
    }

    /**
     * Resolves a token document ID to its display name within a given scene.
     * Falls back to '[unknown]' if the token cannot be found.
     * @param {string} sceneId
     * @param {string} tokenId
     * @returns {string}
     */
    static resolveTokenName(sceneId, tokenId) {
        if (!tokenId) return '[none]';
        if (canvas?.scene?.id === sceneId) {
            const liveToken = canvas.tokens.get(tokenId);
            if (liveToken) return liveToken.name;
        }
        const scene = game.scenes.get(sceneId);
        const tokenDoc = scene?.tokens?.get(tokenId);
        return tokenDoc?.name ?? '[unknown]';
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Generic settings helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Reads a single module setting by key.
     * @param {string} key
     * @returns {*}
     */
    static setting(key) {
        return game.settings.get(MOD_ID, key);
    }

    /**
     * Writes a single module setting by key.
     * @param {string} key
     * @param {*} newValue
     * @returns {Promise<void>}
     */
    static async modifySetting(key, newValue) {
        await game.settings.set(MOD_ID, key, newValue);
    }

    /**
     * Promise-based delay utility.
     * @param {number} msec
     * @returns {Promise<void>}
     */
    static async sleep(msec) {
        return new Promise(resolve => setTimeout(resolve, msec));
    }
}
