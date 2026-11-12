// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Super+Arrow keys, behaving like Win+Arrow in Windows 11.
//
// GNOME's own bindings ("View split on left/right", "Maximize window",
// "Restore window") keep their keys; only what they do changes, so
// rebinding them in GNOME Settings still works. Each side of the screen is a
// ladder: top quarter ↔ half ↔ bottom quarter → minimized, and the opposite
// arrow walks back through "restored" in the middle:
//
//   Super+Left   restored → left half → right half of the monitor on the left
//                right half → restored; top-right quarter → top-left quarter
//   Super+Up     restored → maximized → top half;  left half → top-left quarter
//                bottom-left quarter → left half
//   Super+Down   maximized → restored → minimized; left half → bottom-left
//                quarter → minimized; top-left quarter → left half
//   Super+Alt+Up / Super+Alt+Down   top / bottom half
//
// Snap Assist opens once Super is released, so the arrows can be pressed
// several times in a row first, as on Windows.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Compat from './compat.js';
import * as G from './geometry.js';
import {isSnappable} from './snapper.js';

const OVERRIDES = {
    'toggle-tiled-left': 'left',
    'toggle-tiled-right': 'right',
    'maximize': 'up',
    'unmaximize': 'down',
};

// GNOME Shell's own uses of keys we bind (Super+Alt+Up/Down open the
// overview): while we run, we take those keys from them.
const SHELL_KEYBINDINGS = 'org.gnome.shell.keybindings';
const TAKEOVER = {
    'snap-top-half': 'shift-overview-up',
    'snap-bottom-half': 'shift-overview-down',
};

/** '<Alt><Super>Up' and '<Super><Mod1>up' are the same accelerator. */
function normalizeAccel(accel) {
    const aliases = {mod1: 'alt', mod4: 'super', primary: 'control', ctrl: 'control'};
    const mods = (accel.match(/<[^>]+>/g) ?? [])
        .map(m => m.slice(1, -1).toLowerCase())
        .map(m => aliases[m] ?? m)
        .sort();
    return `${mods.join('+')}+${accel.replace(/<[^>]+>/g, '').toLowerCase()}`;
}

const SUPER_MODS = [
    Meta.VirtualModifier?.SUPER_MASK,
    Clutter.ModifierType.SUPER_MASK,
    Clutter.ModifierType.MOD4_MASK,
].filter(m => m !== undefined).reduce((a, b) => a | b, 0);

// Moving to the next quarter or half sideways.
const SIDEWAYS = {
    'left': {left: 'NEXT:right', right: 'RESTORE'},
    'right': {right: 'NEXT:left', left: 'RESTORE'},
    'top-left': {left: 'NEXT:top-right', right: 'top-right'},
    'top-right': {right: 'NEXT:top-left', left: 'top-left'},
    'bottom-left': {left: 'NEXT:bottom-right', right: 'bottom-right'},
    'bottom-right': {right: 'NEXT:bottom-left', left: 'bottom-left'},
    'top': {left: 'top-left', right: 'top-right'},
    'bottom': {left: 'bottom-left', right: 'bottom-right'},
};

const VERTICAL = {
    'left': {up: 'top-left', down: 'bottom-left'},
    'right': {up: 'top-right', down: 'bottom-right'},
    'top-left': {up: 'MAXIMIZE', down: 'left'},
    'top-right': {up: 'MAXIMIZE', down: 'right'},
    'bottom-left': {up: 'left', down: 'MINIMIZE'},
    'bottom-right': {up: 'right', down: 'MINIMIZE'},
    'top': {up: 'MAXIMIZE', down: 'RESTORE'},
    'bottom': {up: 'RESTORE', down: 'MINIMIZE'},
};

export class KeyboardController {
    constructor(ext) {
        this._ext = ext;
        this._overridden = false;
        this._assistWaitId = 0;
        this._pendingAssist = null;

        this._sync();
        ext.settings.connectObject('changed::keyboard-snapping', () => this._sync(), this);

        this._shellKeys = new Gio.Settings({schema_id: SHELL_KEYBINDINGS});
        this._takeOverShellKeys();
        ext.settings.connectObject(
            'changed::snap-top-half', () => this._retakeShellKeys(),
            'changed::snap-bottom-half', () => this._retakeShellKeys(),
            this);

        const modes = Shell.ActionMode.NORMAL;
        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        Main.wm.addKeybinding('show-snap-layouts', ext.settings, flags, modes,
            () => ext.flyout.toggle(global.display.focus_window));
        Main.wm.addKeybinding('snap-top-half', ext.settings, flags, modes,
            () => this._halfVertical(global.display.focus_window, 'top'));
        Main.wm.addKeybinding('snap-bottom-half', ext.settings, flags, modes,
            () => this._halfVertical(global.display.focus_window, 'bottom'));
    }

    destroy() {
        this._cancelAssistWait();
        this._ext.settings.disconnectObject(this);
        Main.wm.removeKeybinding('show-snap-layouts');
        Main.wm.removeKeybinding('snap-top-half');
        Main.wm.removeKeybinding('snap-bottom-half');
        this._restoreBuiltins();
        this._restoreShellKeys();
        this._shellKeys = null;
    }

    // -- Keys GNOME Shell uses for something else ----------------------------
    //
    // Two bindings for one key make Mutter pick one at random, so GNOME's are
    // set aside while this runs. The original values are kept in our own
    // settings until they've been put back, so a crash can't lose them.

    _takeOverShellKeys() {
        const saved = this._savedShellKeys();
        for (const [ours, theirs] of Object.entries(TAKEOVER)) {
            const mine = new Set(this._ext.settings.get_strv(ours).map(normalizeAccel));
            const current = this._shellKeys.get_strv(theirs);
            const keep = current.filter(a => !mine.has(normalizeAccel(a)));
            if (keep.length === current.length)
                continue;
            if (!(theirs in saved))
                saved[theirs] = current;
            this._shellKeys.set_strv(theirs, keep);
        }
        this._ext.settings.set_string('saved-shell-keybindings', JSON.stringify(saved));
    }

    _restoreShellKeys() {
        const saved = this._savedShellKeys();
        for (const [key, value] of Object.entries(saved))
            this._shellKeys?.set_strv(key, value);
        this._ext.settings.set_string('saved-shell-keybindings', '{}');
    }

    _retakeShellKeys() {
        this._restoreShellKeys();
        this._takeOverShellKeys();
    }

    _savedShellKeys() {
        try {
            const saved = JSON.parse(this._ext.settings.get_string('saved-shell-keybindings'));
            return saved && typeof saved === 'object' ? saved : {};
        } catch {
            return {};
        }
    }

    _sync() {
        if (this._ext.settings.get_boolean('keyboard-snapping'))
            this._overrideBuiltins();
        else
            this._restoreBuiltins();
    }

    _overrideBuiltins() {
        if (this._overridden)
            return;
        this._overridden = true;
        for (const [name, dir] of Object.entries(OVERRIDES)) {
            // GNOME 46–47 call handlers with (display, window, binding),
            // later versions with (display, window, event, binding).
            Meta.keybindings_set_custom_handler(name, (display, win, ...rest) => {
                const binding = rest.find(arg => typeof arg?.get_modifiers === 'function') ?? null;
                this._onKey(dir, win, binding);
            });
        }
    }

    _restoreBuiltins() {
        if (!this._overridden)
            return;
        this._overridden = false;
        for (const name of Object.keys(OVERRIDES))
            Meta.keybindings_set_custom_handler(name, null);
    }

    /**
     * Super+key pressed while Snap Assist or the layouts flyout has the
     * keyboard: act as if it had reached GNOME. Returns true if handled.
     */
    forward(event) {
        const state = event.get_state();
        if (!(state & SUPER_MODS))
            return false;
        const key = event.get_key_symbol();
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
        const win = global.display.focus_window;
        const dir = {
            [Clutter.KEY_Left]: 'left', [Clutter.KEY_Right]: 'right',
            [Clutter.KEY_Up]: 'up', [Clutter.KEY_Down]: 'down',
        }[key];
        if (!dir || !win)
            return false;
        this._ext.dismissUi();
        if (alt && (dir === 'up' || dir === 'down'))
            this._halfVertical(win, dir === 'up' ? 'top' : 'bottom');
        else if (!alt && this._ext.settings.get_boolean('keyboard-snapping') && isSnappable(win))
            this._step(dir, win);
        else
            return false;
        return true;
    }

    // -- Dispatch ------------------------------------------------------------

    _onKey(dir, win, binding) {
        win ??= global.display.focus_window;
        if (!win)
            return;

        // Alt+F5 etc. (no Super) keep GNOME's plain behaviour.
        const viaSuper = !binding ||
            (binding.get_modifiers() & SUPER_MODS) !== 0 ||
            (binding.get_mask() & Clutter.ModifierType.MOD4_MASK) !== 0;
        if (!viaSuper) {
            this._gnomeDefault(dir, win);
            return;
        }
        if (!isSnappable(win) || Main.overview.visible) {
            this._gnomeDefault(dir, win);
            return;
        }
        this._ext.dismissUi();

        try {
            this._step(dir, win);
        } catch (e) {
            logError(e, '[window-snapping] keyboard');
        }
    }

    _gnomeDefault(dir, win) {
        switch (dir) {
        case 'up':
            if (win.can_maximize())
                Compat.maximize(win);
            break;
        case 'down':
            if (Compat.maximizeFlags(win) !== 0)
                Compat.unmaximize(win);
            break;
        default: {
            // GNOME toggles side tiling; without its edge tiling, a half snap.
            const monitor = win.get_monitor();
            const record = this._ext.snapper.recordFor(win);
            if (record?.name === dir)
                this._ext.snapper.unsnap(win);
            else
                this._ext.snapper.snap(win, G.ZONES[dir], monitor);
        }
        }
    }

    /** Current state of a window: 'maximized', a zone name, 'zone' (custom) or 'floating'. */
    _state(win) {
        if (Compat.isMaximized(win))
            return 'maximized';
        const record = this._ext.snapper.recordFor(win);
        if (record)
            return record.name ?? 'zone';
        return 'floating';
    }

    _step(dir, win) {
        const snapper = this._ext.snapper;
        const monitor = win.get_monitor();
        const state = this._state(win);
        let action;

        if (dir === 'left' || dir === 'right') {
            if (state === 'floating' || state === 'maximized')
                action = dir;
            else if (state === 'zone')
                action = this._customZoneSideways(win, dir);
            else
                action = SIDEWAYS[state]?.[dir] ?? dir;
        } else if (dir === 'up') {
            if (state === 'floating')
                action = 'MAXIMIZE';
            else if (state === 'maximized')
                action = 'top';
            else if (state === 'zone')
                action = 'MAXIMIZE';
            else
                action = VERTICAL[state]?.up ?? 'MAXIMIZE';
        } else {
            if (state === 'floating')
                action = 'MINIMIZE';
            else if (state === 'maximized' || state === 'zone')
                action = 'RESTORE';
            else
                action = VERTICAL[state]?.down ?? 'RESTORE';
        }

        this._ext.log(`key ${dir}: ${state} → ${action}`);
        let target = monitor;
        if (action.startsWith('NEXT:')) {
            action = action.slice(5);
            target = this._neighbourMonitor(monitor, dir);
        }

        switch (action) {
        case 'MAXIMIZE':
            snapper.maximize(win, monitor);
            return;
        case 'MINIMIZE':
            if (win.can_minimize())
                win.minimize();
            return;
        case 'RESTORE':
            this._restore(win, monitor);
            return;
        default: {
            const record = snapper.snap(win, G.ZONES[action], target);
            if (record)
                this._assistWhenSuperReleased(record);
        }
        }
    }

    /** Layout zones (thirds etc.): sideways leaves for the side's half or the next monitor. */
    _customZoneSideways(win, dir) {
        const zone = this._ext.snapper.recordFor(win).zone;
        if (dir === 'left')
            return zone.x <= 0.001 ? 'NEXT:right' : 'left';
        return zone.x + zone.w >= 0.999 ? 'NEXT:left' : 'right';
    }

    /**
     * The monitor in a direction, wrapping around (on a single monitor that's
     * the same monitor, so Super+Left on a left half goes to the right half).
     */
    _neighbourMonitor(monitor, dir) {
        const direction = dir === 'left' ? Meta.DisplayDirection.LEFT : Meta.DisplayDirection.RIGHT;
        const next = global.display.get_monitor_neighbor_index(monitor, direction);
        if (next >= 0)
            return next;
        // Wrap: the farthest monitor in the other direction.
        const back = dir === 'left' ? Meta.DisplayDirection.RIGHT : Meta.DisplayDirection.LEFT;
        let index = monitor;
        for (let i = 0; i < global.display.get_n_monitors(); i++) {
            const n = global.display.get_monitor_neighbor_index(index, back);
            if (n < 0)
                break;
            index = n;
        }
        return index;
    }

    /** Back to the floating size, on the monitor the window is on now. */
    _restore(win, monitor) {
        const snapper = this._ext.snapper;
        const rect = snapper.restoreRectFor(win);
        const wa = snapper.workArea(monitor, win);
        // Keep it on this monitor (it may have been snapped across monitors).
        const fromMonitor = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({x: rect.x, y: rect.y, width: rect.width, height: rect.height}));
        if (fromMonitor !== monitor && fromMonitor >= 0) {
            const from = snapper.workArea(fromMonitor, win);
            rect.x = wa.x + Math.round((rect.x - from.x) * wa.width / from.width);
            rect.y = wa.y + Math.round((rect.y - from.y) * wa.height / from.height);
        }
        rect.width = Math.min(rect.width, wa.width);
        rect.height = Math.min(rect.height, wa.height);
        rect.x = Math.min(Math.max(rect.x, wa.x), wa.x + wa.width - rect.width);
        rect.y = Math.min(Math.max(rect.y, wa.y), wa.y + wa.height - rect.height);
        snapper.unsnap(win, {rect});
    }

    _halfVertical(win, which) {
        this._ext.log(`key ${which} half for "${win?.get_title()}"`);
        if (!win || !isSnappable(win) || Main.overview.visible)
            return;
        this._ext.dismissUi();
        const record = this._ext.snapper.snap(win, G.ZONES[which], win.get_monitor());
        if (record)
            this._assistWhenSuperReleased(record);
    }

    // -- Snap Assist after keyboard snaps ------------------------------------

    _assistWhenSuperReleased(record) {
        this._pendingAssist = record;
        if (this._assistWaitId)
            return;
        this._assistWaitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            const [, , mods] = global.get_pointer();
            if (mods & SUPER_MODS)
                return GLib.SOURCE_CONTINUE;
            this._assistWaitId = 0;
            const pending = this._pendingAssist;
            this._pendingAssist = null;
            // Only if it's still where we put it.
            if (pending && this._ext.snapper.recordFor(pending.win) === pending &&
                global.display.focus_window === pending.win)
                this._ext.assist.afterSnap(pending);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelAssistWait() {
        if (this._assistWaitId) {
            GLib.source_remove(this._assistWaitId);
            this._assistWaitId = 0;
        }
        this._pendingAssist = null;
    }
}
