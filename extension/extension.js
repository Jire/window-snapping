// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Window Snapping
//
// Windows 11-style window snapping for GNOME Shell:
//
//  - drag a window to a screen edge for half the screen, to a corner for a
//    quarter, to the top to maximize (dragPreview + dragSnap.js)
//  - drag it to the top centre for the snap layouts bar (snapBar.js)
//  - after snapping, Snap Assist offers your other windows for the space
//    that's left (snapAssist.js)
//  - Super+Arrow keys behave exactly like Win+Arrow, Super+Z opens the snap
//    layouts (keyboard.js, flyout.js)
//  - snapped windows resize together and restore their size when dragged
//    away (resize.js, snapper.js)
//
// GNOME's own edge tiling is switched off while this runs (it would fight
// over the same drags) and switched back on when the extension is disabled.

import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Motion, MorphManager} from './animation.js';
import {DragController} from './dragSnap.js';
import {LayoutFlyout} from './flyout.js';
import {KeyboardController} from './keyboard.js';
import {ResizeController} from './resize.js';
import {SnapAssist} from './snapAssist.js';
import {Snapper} from './snapper.js';

const MUTTER_SCHEMA = 'org.gnome.mutter';

export default class WindowSnappingExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._debug = this.settings.get_boolean('debug');
        this.motion = new Motion();
        this.motion.mode = this.settings.get_string('animations');
        this.settings.connectObject(
            'changed::debug', () => {
                this._debug = this.settings.get_boolean('debug');
            },
            'changed::animations', () => {
                this.motion.mode = this.settings.get_string('animations');
            },
            this);

        this._takeOverEdgeTiling();

        this.morphs = new MorphManager(this.motion);
        this.snapper = new Snapper(this);
        this.assist = new SnapAssist(this);
        this.drag = new DragController(this);
        this.resize = new ResizeController(this);
        this.flyout = new LayoutFlyout(this);
        this.keyboard = new KeyboardController(this);

        St.Settings.get().connectObject(
            'notify::accent-color', () => this._onStyleChanged(),
            'notify::color-scheme', () => this._onStyleChanged(),
            this);
        Main.sessionMode.connectObject('updated', () => this._onSessionModeUpdated(), this);
        Main.overview.connectObject('showing', () => this.dismissUi(), this);
        this.log('enabled');
    }

    disable() {
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        St.Settings.get().disconnectObject(this);

        this.keyboard?.destroy();
        this.flyout?.destroy();
        this.resize?.destroy();
        this.drag?.destroy();
        this.assist?.destroy();
        this.snapper?.destroy();
        this.morphs?.destroy();
        this.keyboard = this.flyout = this.resize = this.drag = null;
        this.assist = this.snapper = this.morphs = null;

        this._restoreEdgeTiling();
        this.settings?.disconnectObject(this);
        this.settings = null;
        this.motion = null;
    }

    /** True while the user is moving or resizing this window. */
    isGrabbing(win) {
        return !!(this.drag?.isDragging(win) || this.resize?.isResizing(win));
    }

    /** Close any transient UI (Snap Assist, the layouts flyout). */
    dismissUi() {
        this.assist?.dismiss();
        this.flyout?.close();
    }

    log(message) {
        if (this._debug)
            console.log(`[window-snapping] ${message}`);
    }

    // -- GNOME's edge tiling -------------------------------------------------
    //
    // Mutter's own edge tiling handles the same drags, so it's turned off
    // while this extension runs. The original value is kept in our own
    // settings until it has been put back, so even a crash can't lose it.

    _takeOverEdgeTiling() {
        this._mutterSettings = new Gio.Settings({schema_id: MUTTER_SCHEMA});
        if (this.settings.get_string('saved-edge-tiling') === '')
            this.settings.set_string('saved-edge-tiling', String(this._mutterSettings.get_boolean('edge-tiling')));
        this._mutterSettings.set_boolean('edge-tiling', false);
        this._mutterSettings.connectObject('changed::edge-tiling', () => {
            if (!this._mutterSettings.get_boolean('edge-tiling'))
                return;
            // Turned on elsewhere (GNOME Settings, Tweaks): remember that as
            // the value to restore, and keep it off while we're running.
            this.settings.set_string('saved-edge-tiling', 'true');
            this._mutterSettings.set_boolean('edge-tiling', false);
        }, this);
    }

    _restoreEdgeTiling() {
        if (!this._mutterSettings)
            return;
        this._mutterSettings.disconnectObject(this);
        const saved = this.settings?.get_string('saved-edge-tiling');
        if (saved === 'true' || saved === 'false')
            this._mutterSettings.set_boolean('edge-tiling', saved === 'true');
        this.settings?.set_string('saved-edge-tiling', '');
        this._mutterSettings = null;
    }

    // -- Misc ----------------------------------------------------------------

    _onStyleChanged() {
        this.drag?.updateColors();
        this.assist?.updateColors();
        this.flyout?.updateColors();
        this.resize?.updateColors();
    }

    _onSessionModeUpdated() {
        if (Main.sessionMode.isLocked)
            this.dismissUi();
    }
}
