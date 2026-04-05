import { Config } from './config.js';
import { HordeHud } from './horde-hud.js';
import { HordeManager } from './horde-manager.js';
import { VisualMarkers } from './visual-markers.js';
import { Dashboard } from './dashboard.js';

// ─────────────────────────────────────────────────────────────────────────────
// DH Horde — Module bootstrap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register settings during the 'setup' hook so they are available before 'ready'.
 * All Canvas-dependent initialization defers to the 'ready' hook.
 */
Hooks.once('setup', () => {
    Config.init();
});

/**
 * Initialize all subsystems once Foundry is fully ready.
 * Template preloading, HUD injection, auto-promotion hooks, PIXI markers,
 * and dashboard registration all happen here.
 */
Hooks.once('ready', async () => {
    await foundry.applications.handlebars.loadTemplates([
        'modules/dh-horde/templates/horde-hud-dialog.hbs',
        'modules/dh-horde/templates/dashboard.hbs'
    ]);

    HordeHud.init();
    HordeManager.init();
    VisualMarkers.init();
    Dashboard.init();

    Config.ready = true;
    console.log(`dh-horde | Ready! v${game.modules.get('dh-horde').version}`);
});
