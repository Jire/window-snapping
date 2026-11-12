// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The few Mutter/Shell APIs that differ between the supported GNOME versions,
// wrapped so the rest of the extension doesn't have to care.
//
//   GNOME 46–48: window.maximize(flags) / unmaximize(flags) / get_maximized()
//   GNOME 49+:   window.maximize() / unmaximize() / set_maximize_flags(flags) /
//                set_unmaximize_flags(flags) / get_maximize_flags()
//   GNOME 46–47: Meta.CursorTracker.get_for_display(); 48+: global.backend
//   GNOME 46–48: the cursor tracker only reports motion while tracked

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

const NEW_MAXIMIZE_API = typeof Meta.Window.prototype.set_maximize_flags === 'function';

/** Meta.MaximizeFlags currently set on the window (0 when floating). */
export function maximizeFlags(win) {
    return NEW_MAXIMIZE_API ? win.get_maximize_flags() : win.get_maximized();
}

/** True when the window is maximized in both directions. */
export function isMaximized(win) {
    return maximizeFlags(win) === Meta.MaximizeFlags.BOTH;
}

/** Maximize in both directions. */
export function maximize(win) {
    if (NEW_MAXIMIZE_API)
        win.maximize();
    else
        win.maximize(Meta.MaximizeFlags.BOTH);
}

/** Maximize in one or both directions (Meta.MaximizeFlags). */
export function maximizeFlagsSet(win, flags) {
    if (NEW_MAXIMIZE_API)
        win.set_maximize_flags(flags);
    else
        win.maximize(flags);
}

/** Remove the given maximize directions (default: both). */
export function unmaximize(win, flags = Meta.MaximizeFlags.BOTH) {
    if (NEW_MAXIMIZE_API) {
        if (flags === Meta.MaximizeFlags.BOTH)
            win.unmaximize();
        else
            win.set_unmaximize_flags(flags);
    } else {
        win.unmaximize(flags);
    }
}

/** Whether GNOME wants animations right now (system setting + reduced motion). */
export function animationsEnabled() {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return false;
    // St.ReducedMotion exists from GNOME 48.
    if (St.ReducedMotion && settings.reduced_motion === St.ReducedMotion.REDUCE)
        return false;
    return true;
}

// GNOME's accent palette (st-theme-context.c). St only exposes the accent as
// an enum, so map it here. GNOME 46 has no accent setting: always blue.
const ACCENTS = {
    blue: [0x35, 0x84, 0xe4],
    teal: [0x21, 0x90, 0xa4],
    green: [0x3a, 0x94, 0x4a],
    yellow: [0xc8, 0x88, 0x00],
    orange: [0xed, 0x5b, 0x00],
    red: [0xe6, 0x2d, 0x42],
    pink: [0xd5, 0x61, 0x99],
    purple: [0x91, 0x41, 0xac],
    slate: [0x6f, 0x83, 0x96],
};

/** The system accent colour as [r, g, b] (0–255). */
export function accentRgb() {
    const value = St.Settings.get().accent_color;
    if (value === undefined || !St.SystemAccentColor)
        return ACCENTS.blue;
    for (const [name, rgb] of Object.entries(ACCENTS)) {
        if (St.SystemAccentColor[name.toUpperCase()] === value)
            return rgb;
    }
    return ACCENTS.blue;
}

/** 'light' or 'dark': which variant the Shell's own UI is using. */
export function styleVariant(Main) {
    try {
        return Main.getStyleVariant?.() === 'light' ? 'light' : 'dark';
    } catch {
        return 'dark';
    }
}

// St.BoxLayout: GNOME 48 added "orientation" and later versions dropped
// "vertical".
const BOX_HAS_ORIENTATION = (() => {
    try {
        return !!St.BoxLayout.find_property('orientation');
    } catch {
        return 'orientation' in St.BoxLayout.prototype;
    }
})();

/** A vertical St.BoxLayout on every GNOME version. */
export function vbox(params = {}) {
    return new St.BoxLayout(BOX_HAS_ORIENTATION
        ? {...params, orientation: Clutter.Orientation.VERTICAL}
        : {...params, vertical: true});
}

/**
 * Follow the pointer: `onMove` runs on every pointer motion until the
 * returned function is called.
 */
export function watchPointer(onMove) {
    const tracker = global.backend?.get_cursor_tracker?.() ??
        Meta.CursorTracker.get_for_display(global.display);
    const id = tracker.connect('position-invalidated', onMove);
    const tracked = typeof tracker.track_position === 'function';
    if (tracked)
        tracker.track_position();
    let stopped = false;
    return () => {
        if (stopped)
            return;
        stopped = true;
        tracker.disconnect(id);
        if (tracked)
            tracker.untrack_position();
    };
}
