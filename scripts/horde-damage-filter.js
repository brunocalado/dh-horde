/*!
 * Daggerheart: Horde
 * 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */
import { Config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// HordeDamageFilter — an area attack hitting several tokens of one horde
//                     counts once, because the horde is a single adversary.
// ─────────────────────────────────────────────────────────────────────────────

// Daggerheart applies damage to every target in one synchronous loop
// (DamageField.applyDamage, onApplyDamage, onRollSimple), but since 2.12
// takeDamage awaits fromUuid(actionUuid) before firing preTakeDamage. When the
// action lives in a compendium that await is a server round trip, so the hooks of
// one click no longer land in the same microtask, and they may arrive out of order.
// Group ids are therefore remembered for a short time window after the first hit:
// one click counts once per horde, while separate clicks (seconds apart) add up.
// The first target's damage wins. Applying the largest instead would mean cancelling
// every hit and re-applying through a second takeDamage that bypasses this filter,
// and the horde would drop out of the chat damage summary along with its Undo.
const WINDOW_MS = 500;
const seen = new Set();

function onlyFirstPerHorde(actor) {
    const group = Config.findGroupByTokenId(actor.token?.id);
    if (!group) return;
    if (seen.size === 0) setTimeout(() => seen.clear(), WINDOW_MS);
    if (seen.has(group.id)) return false;
    seen.add(group.id);
}

export const HordeDamageFilter = {
    /**
     * Runs on every client, not only the GM: the hooks fire on the client of
     * whoever applied the damage.
     */
    init() {
        Hooks.on('daggerheart.preTakeDamage', onlyFirstPerHorde);
        Hooks.on('daggerheart.preTakeHealing', onlyFirstPerHorde);
    }
};
