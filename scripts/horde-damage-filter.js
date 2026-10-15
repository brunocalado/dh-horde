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
// (DamageField.applyDamage, onApplyDamage, onRollSimple), and its
// preTakeDamage/preTakeHealing hooks fire before the first await in
// takeDamage/takeHealing. Group ids seen in the current turn are cleared on the
// next microtask, so one click counts once per horde while separate clicks add up.
// The first target's damage wins. Applying the largest instead would mean cancelling
// every hit and re-applying through a second takeDamage that bypasses this filter,
// and the horde would drop out of the chat damage summary along with its Undo.
const seen = new Set();

function onlyFirstPerHorde(actor) {
    const group = Config.findGroupByTokenId(actor.token?.id);
    if (!group) return;
    if (seen.size === 0) queueMicrotask(() => seen.clear());
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
