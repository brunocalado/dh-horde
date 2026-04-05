import { Config } from './config.js';
import { HordeManager } from './horde-manager.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// ─────────────────────────────────────────────────────────────────────────────
// HordeHudDialog — AppV2 dialog with horde actions (Multiply, Move Close/Far/All, Dissolve)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ApplicationV2-based dialog for horde token actions.
 * Opens from the Token HUD button on adversary tokens with system.type === "horde".
 */
class HordeHudDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: 'dh-horde-hud-dialog',
        classes: ['dh-horde-hud-app'],
        window: { title: 'Horde Actions' },
        position: { width: 280 },
        actions: {
            multiply:         HordeHudDialog.#onMultiply,
            'move-close':     HordeHudDialog.#onMoveClose,
            'move-far':       HordeHudDialog.#onMoveFar,
            'move-all':       HordeHudDialog.#onMoveAll,
            dissolve:         HordeHudDialog.#onDissolve,
            'open-dashboard': HordeHudDialog.#onOpenDashboard
        }
    };

    static PARTS = {
        main: { template: 'modules/dh-horde/templates/horde-hud-dialog.hbs' }
    };

    /**
     * @param {Token} token - The horde token the HUD was opened on
     */
    constructor(token) {
        super();
        this.originToken = token;
    }

    /**
     * Builds template context for the horde HUD dialog.
     * @returns {Promise<object>}
     */
    async _prepareContext() {
        const group = Config.getGroupByTokenId(this.originToken.id);
        const hasGroup = !!group;
        const hasTargets = game.user.targets.size > 0;

        return {
            hasGroup,
            hasTargets,
            tokenName: this.originToken.name,
            memberCount: group?.memberIds?.length ?? 0
        };
    }

    static async #onMultiply() {
        this.close();
        await HordeManager.multiplyHorde(this.originToken);
    }

    static async #onMoveClose() {
        this.close();
        await HordeManager.moveHorde(this.originToken, 'close');
    }

    static async #onMoveFar() {
        this.close();
        await HordeManager.moveHorde(this.originToken, 'far');
    }

    static async #onMoveAll() {
        this.close();
        await HordeManager.moveHorde(this.originToken, 'all');
    }

    static async #onDissolve() {
        this.close();
        await HordeManager.dissolveHorde(this.originToken);
    }

    static #onOpenDashboard() {
        this.close();
        window.HordeDashboard?.open();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HordeHud — Token HUD button injection
// ─────────────────────────────────────────────────────────────────────────────

export class HordeHud {

    /**
     * Hooks into the Token HUD to inject the Horde button on qualifying tokens.
     */
    static init() {
        Hooks.on('renderTokenHUD', (app, html, data) => {
            if (!game.user.isGM) return;
            HordeHud._injectHUDButton(app, html);
        });
    }

    /**
     * Adds the Horde button to the Token HUD right column if the token
     * is an adversary with system.type === "horde".
     */
    static _injectHUDButton(app, html) {
        const root = html instanceof HTMLElement ? html : html[0];
        if (!root) return;

        const token = app.object ?? app.token;
        if (!token) return;

        if (token.actor?.type !== 'adversary') return;
        if (token.actor?.system?.type !== 'horde') return;

        const colRight = root.querySelector('.col.right');
        if (!colRight) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.classList.add('control-icon', 'dh-horde-hud-btn');
        btn.setAttribute('data-tooltip', 'Horde Actions');
        btn.innerHTML = '<i class="fas fa-chess-rook"></i>';

        btn.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            game.tooltip.deactivate();
            app.close?.();
            new HordeHudDialog(token).render(true);
        });

        colRight.appendChild(btn);
    }
}
