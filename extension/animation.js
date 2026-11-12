// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Smooth window geometry changes ("morphs") for snapping.
//
// Works like GNOME's own maximize animation: before the window changes size,
// take a snapshot of it and freeze its actor, so the old frame stays on
// screen while the app redraws at the new size. Once Mutter reports the new
// geometry, the snapshot flies to the new rectangle and fades out while the
// real window grows/shrinks from the old rectangle into place. Apps that are
// slow to redraw therefore never show a half-drawn or stretched frame.
//
// Mutter aborts the whole shell if a window actor is thawed more often than
// it was frozen, so every freeze here is paired with exactly one guarded
// thaw, and destroyed actors are never touched.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {animationsEnabled} from './compat.js';

export const MORPH_MS = 250;
// Give up waiting for the app to resize after this long and just finish.
const SETTLE_TIMEOUT_MS = 600;

const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10) || 0;
// ease({animationRequired}) exists from GNOME 47.
const CAN_FORCE_ANIMATION = SHELL_MAJOR >= 47;

/**
 * Animation policy shared by everything the extension animates.
 * mode: 'system' (follow GNOME), 'always' or 'never'.
 */
export class Motion {
    constructor() {
        this.mode = 'system';
    }

    get enabled() {
        if (this.mode === 'never')
            return false;
        if (this.mode === 'always')
            return CAN_FORCE_ANIMATION || animationsEnabled();
        return animationsEnabled();
    }

    /** actor.ease() that honours the extension's animation setting. */
    ease(actor, params) {
        const p = {...params};
        if (this.mode === 'never') {
            p.duration = 0;
            delete p.delay;
        } else if (this.mode === 'always' && CAN_FORCE_ANIMATION) {
            p.animationRequired = true;
        }
        actor.ease(p);
    }
}

/** Frame rect of a window as a plain object. */
function frameOf(win) {
    const r = win.get_frame_rect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}

class Morph {
    constructor(manager, win, actor) {
        this._manager = manager;
        this._win = win;
        this._actor = actor;
        this._frozen = false;
        this._done = false;
        this._clone = null;
        this._timeoutId = 0;
        this._laterId = 0;
        this._oldRect = frameOf(win);
    }

    /** Snapshot + freeze. Returns false if the window can't be animated. */
    prepare() {
        const r = this._oldRect;
        if (r.width <= 0 || r.height <= 0 || !this._actor.get_texture?.())
            return false;
        let content = null;
        try {
            content = this._actor.paint_to_content(this._win.get_frame_rect());
        } catch {
            return false;
        }
        if (!content)
            return false;

        this._clone = new St.Widget({
            content,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
        });
        this._clone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

        this._actor.freeze();
        this._frozen = true;

        this._win.connectObject(
            'size-changed', () => this._queueStart(),
            'position-changed', () => this._queueStart(),
            'unmanaging', () => this.finish(),
            this);
        this._actor.connectObject('destroy', () => {
            // The actor is gone: never thaw it.
            this._frozen = false;
            this.finish();
        }, this);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_TIMEOUT_MS, () => {
            this._timeoutId = 0;
            this._start();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _queueStart() {
        // Mutter reports position and size separately; wait for both.
        if (this._laterId || this._started)
            return;
        const laters = global.compositor.get_laters();
        this._laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._start();
            return GLib.SOURCE_REMOVE;
        });
    }

    _start() {
        if (this._started || this._done)
            return;
        this._started = true;
        this._win.disconnectObject(this);
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        const src = this._oldRect;
        const dst = frameOf(this._win);
        const actor = this._actor;
        const motion = this._manager.motion;

        if (dst.width <= 0 || dst.height <= 0 || !motion.enabled) {
            this.finish();
            return;
        }

        // Snapshot of the old frame, flying to the new rect while fading out.
        const parent = actor.get_parent();
        parent.add_child(this._clone);
        parent.set_child_above_sibling(this._clone, actor);
        motion.ease(this._clone, {
            x: dst.x,
            y: dst.y,
            scale_x: dst.width / src.width,
            scale_y: dst.height / src.height,
            opacity: 0,
            duration: MORPH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });

        // The real window starts out looking exactly like the old frame and
        // grows into place. Scale around the frame's top-left corner (the
        // actor also contains client-side shadows).
        const buffer = this._win.get_buffer_rect();
        const dx = dst.x - buffer.x, dy = dst.y - buffer.y;
        // get_pivot_point() returns [x, y] in GJS.
        this._savedPivot = actor.get_pivot_point();
        actor.set_pivot_point(buffer.width > 0 ? dx / buffer.width : 0,
            buffer.height > 0 ? dy / buffer.height : 0);
        actor.scale_x = src.width / dst.width;
        actor.scale_y = src.height / dst.height;
        actor.translation_x = src.x - dst.x;
        actor.translation_y = src.y - dst.y;
        motion.ease(actor, {
            scale_x: 1,
            scale_y: 1,
            translation_x: 0,
            translation_y: 0,
            duration: MORPH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            onStopped: () => this.finish(),
        });

        // Thaw now (not at the end), so the scale applies to the new texture.
        this._thaw();
    }

    _thaw() {
        if (!this._frozen)
            return;
        this._frozen = false;
        if (!this._actor.is_destroyed?.())
            this._actor.thaw();
    }

    /** Stop immediately and leave the window at its real geometry. */
    finish() {
        if (this._done)
            return;
        this._done = true;
        this._win.disconnectObject(this);
        this._actor.disconnectObject(this);
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        this._thaw();
        if (!this._actor.is_destroyed?.()) {
            this._actor.remove_transition('scale-x');
            this._actor.remove_transition('scale-y');
            this._actor.remove_transition('translation-x');
            this._actor.remove_transition('translation-y');
            this._actor.scale_x = 1;
            this._actor.scale_y = 1;
            this._actor.translation_x = 0;
            this._actor.translation_y = 0;
            if (this._savedPivot) {
                const [px, py] = this._savedPivot;
                this._actor.set_pivot_point(Number.isFinite(px) ? px : 0, Number.isFinite(py) ? py : 0);
            }
        }
        this._clone?.destroy();
        this._clone = null;
        this._manager._forget(this._win, this);
    }
}

export class MorphManager {
    constructor(motion) {
        this.motion = motion;
        this._morphs = new Map();
    }

    /**
     * Change a window's geometry with an animation.
     * `apply` performs the change (unmaximize, move_resize_frame, …) and is
     * always called, animated or not. `target`, if known, is the frame rect
     * the window will end up with.
     */
    run(win, apply, target = null) {
        const actor = win.get_compositor_private();
        this._morphs.get(win)?.finish();

        // Nothing would move: don't freeze the window waiting for a change.
        const r = win.get_frame_rect();
        const unchanged = target && target.x === r.x && target.y === r.y &&
            target.width === r.width && target.height === r.height;

        let morph = null;
        if (actor && !unchanged && this.motion.enabled && !Main.overview.visible) {
            morph = new Morph(this, win, actor);
            if (morph.prepare())
                this._morphs.set(win, morph);
            else
                morph = null;
        }
        try {
            apply();
        } catch (e) {
            morph?.finish();
            throw e;
        }
    }

    isAnimating(win) {
        return this._morphs.has(win);
    }

    _forget(win, morph) {
        if (this._morphs.get(win) === morph)
            this._morphs.delete(win);
    }

    destroy() {
        for (const morph of [...this._morphs.values()])
            morph.finish();
        this._morphs.clear();
    }
}
