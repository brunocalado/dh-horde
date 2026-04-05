import { Config } from './config.js';

const MOD_ID = "dh-horde";

// Leader badge color (red) and member badge color (steel blue)
const LEADER_COLOR = 0xaa0000;
const MEMBER_COLOR = 0x3a7abf;

/**
 * VisualMarkers
 * Renders PIXI-based badges directly on the canvas over horde tokens.
 * Only visible to the GM.
 *
 * Leaders get a red border + crown badge; members get a blue border + pawn badge.
 */
export class VisualMarkers {

    /** @type {Map<string, PIXI.Container>} tokenId → PIXI container */
    static _containers = new Map();

    /**
     * Registers Foundry hooks for canvas/token lifecycle events.
     * Called during the Foundry 'ready' hook via main.js.
     *
     * IMPORTANT: canvasReady fires BEFORE 'ready' on initial world load,
     * so we also call _refreshAll() directly here if the canvas is already up.
     */
    static init() {
        Hooks.on('canvasReady', () => {
            VisualMarkers._refreshAll();
        });

        Hooks.on('createToken', (tokenDoc) => {
            VisualMarkers._refreshToken(tokenDoc.id);
        });

        Hooks.on('updateToken', (tokenDoc) => {
            VisualMarkers._refreshToken(tokenDoc.id);
        });

        Hooks.on('deleteToken', (tokenDoc) => {
            VisualMarkers._removeMarker(tokenDoc.id);
        });

        // Refresh all markers when horde group settings change
        Hooks.on('updateSetting', (settingDoc) => {
            if (settingDoc.key?.startsWith(`${MOD_ID}.`)) {
                VisualMarkers._refreshAll();
            }
        });

        // Canvas was already ready before this hook registered (world load).
        // Draw badges immediately so they appear without needing a token move.
        if (canvas?.ready) {
            VisualMarkers._refreshAll();
        }
    }

    // ───────────────────────────────────────────────────────────────
    //  Refresh operations
    // ───────────────────────────────────────────────────────────────

    /**
     * Refresh all markers in the current scene.
     */
    static _refreshAll() {
        if (!game.user.isGM) return;
        if (!canvas?.tokens) return;

        VisualMarkers._containers.forEach((_, id) => VisualMarkers._removeMarker(id));

        for (const token of canvas.tokens.placeables) {
            VisualMarkers._drawMarkerForToken(token);
        }
    }

    /**
     * Refresh the marker for a single token by document ID.
     * @param {string} tokenDocId
     */
    static _refreshToken(tokenDocId) {
        if (!game.user.isGM) return;
        if (!canvas?.tokens) return;

        VisualMarkers._removeMarker(tokenDocId);

        const token = canvas.tokens.get(tokenDocId);
        if (token) VisualMarkers._drawMarkerForToken(token);
    }

    /**
     * Remove and destroy the PIXI container for a token.
     * @param {string} tokenDocId
     */
    static _removeMarker(tokenDocId) {
        const container = VisualMarkers._containers.get(tokenDocId);
        if (container) {
            container.destroy({ children: true });
            VisualMarkers._containers.delete(tokenDocId);
        }
    }

    // ───────────────────────────────────────────────────────────────
    //  Internal drawing
    // ───────────────────────────────────────────────────────────────

    /**
     * Determine which horde group (if any) a token belongs to, and draw accordingly.
     * @param {Token} token - Canvas placeable
     */
    static _drawMarkerForToken(token) {
        const info = VisualMarkers._getGroupMembership(token);
        if (!info) return;

        const { role } = info;
        const isLeader = role === 'leader';
        const borderColor = isLeader ? LEADER_COLOR : MEMBER_COLOR;

        const container = new PIXI.Container();
        container.name = `dh-horde-marker-${token.id}`;

        const w = token.w;
        const h = token.h;

        const border = new PIXI.Graphics();
        const alpha = isLeader ? 0.9 : 0.5;
        const lineWidth = isLeader ? 3 : 2;
        border.lineStyle(lineWidth, borderColor, alpha);
        border.drawRoundedRect(2, 2, w - 4, h - 4, 6);
        container.addChild(border);

        // Badge in top-right corner
        if (isLeader) {
            VisualMarkers._addBadge(container, LEADER_COLOR, w, true);
        } else {
            VisualMarkers._addBadge(container, MEMBER_COLOR, w, false);
        }

        token.addChild(container);
        VisualMarkers._containers.set(token.id, container);
    }

    /**
     * Draw a circular badge in the top-right corner of the token.
     * Uses Unicode glyphs: crown for leaders, pawn for members.
     * @param {PIXI.Container} container
     * @param {number} color - Hex fill color for the badge background
     * @param {number} tokenWidth
     * @param {boolean} isLeaderBadge - true for leader (crown), false for member (pawn)
     */
    static _addBadge(container, color, tokenWidth, isLeaderBadge) {
        const BADGE_SIZE = 22;
        const MARGIN = 4;
        const x = tokenWidth - BADGE_SIZE - MARGIN;
        const y = MARGIN;

        const bg = new PIXI.Graphics();
        bg.beginFill(color, 0.95);
        bg.lineStyle(1.5, 0xffffff, 0.8);
        bg.drawCircle(x + BADGE_SIZE / 2, y + BADGE_SIZE / 2, BADGE_SIZE / 2);
        bg.endFill();
        container.addChild(bg);

        // \u265B = Black Chess Queen (crown) for leaders, \u265F = Chess Pawn for members.
        const iconUnicode = isLeaderBadge ? '\u265B' : '\u265F';

        const style = new PIXI.TextStyle({
            fontFamily: '"Arial Unicode MS", Arial, sans-serif',
            fontSize: 15,
            fill: '#ffffff',
            align: 'center'
        });
        const label = new PIXI.Text(iconUnicode, style);
        label.resolution = (window.devicePixelRatio ?? 1) * 2;
        label.anchor.set(0.5, 0.5);
        label.x = x + BADGE_SIZE / 2;
        label.y = y + BADGE_SIZE / 2;
        container.addChild(label);
    }

    /**
     * Check all configured horde groups and return membership info for a token.
     * @param {Token} token
     * @returns {{ groupIndex: number, role: 'leader'|'member' } | null}
     */
    static _getGroupMembership(token) {
        const tokenId = token.id;
        if (!tokenId) return null;

        const groups = Config.getGroups();
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            if (g.leaderId === tokenId) return { groupIndex: i + 1, role: 'leader' };
            if (g.memberIds.includes(tokenId)) return { groupIndex: i + 1, role: 'member' };
        }

        return null;
    }
}
