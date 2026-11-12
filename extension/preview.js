// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The translucent "this is where the window will go" overlay shown while
// dragging, like Windows 11's snap preview: frosted glass tinted with the
// accent colour, drawn *under* the window being dragged, growing out from the
// pointer and gliding between zones as the pointer moves.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {accentRgb} from './compat.js';

const SHOW_MS = 220;
const MORPH_MS = 200;
const HIDE_MS = 140;
// Gap between the preview and the work area's outer edges / between zones.
export const OUTER_INSET = 8;
export const INNER_INSET = 4;
const RADIUS = 12;
// The blurred layer has square corners, so it sits this far inside the
// rounded outline (radius × (1 − 1/√2), rounded up) and the rim covers it.
const FROST_INSET = Math.ceil(RADIUS * (1 - Math.SQRT1_2)) + 1;

/** Shrink a zone rect for display: more at the work area edges, less between zones. */
export function insetRect(r, workArea, scale = 1) {
    const outer = OUTER_INSET * scale, inner = INNER_INSET * scale;
    const atL = r.x <= workArea.x + 1, atT = r.y <= workArea.y + 1;
    const atR = r.x + r.width >= workArea.x + workArea.width - 1;
    const atB = r.y + r.height >= workArea.y + workArea.height - 1;
    const x1 = r.x + (atL ? outer : inner), y1 = r.y + (atT ? outer : inner);
    const x2 = r.x + r.width - (atR ? outer : inner), y2 = r.y + r.height - (atB ? outer : inner);
    return {x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1)};
}

/** Frosted, tinted rounded rectangle. Used by the preview and by Snap Assist. */
export const FrostedPanel = GObject.registerClass(
class FrostedPanel extends St.Widget {
    _init({styleClass = 'wsnap-glass', blur = true} = {}) {
        super._init({reactive: false});
        // Background blur reads what's already on screen; drawing this actor
        // into an offscreen buffer (Clutter does that for fading groups)
        // would leave it nothing to blur.
        this.offscreen_redirect = Clutter.OffscreenRedirect.NEVER;
        this._frost = null;
        if (blur && Shell.BlurEffect) {
            this._frost = new St.Widget();
            const effect = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND});
            // GNOME 46+ call it "radius"; it used to be "sigma".
            if ('radius' in effect)
                effect.radius = 36;
            else
                effect.sigma = 18;
            effect.brightness = 0.92;
            this._frost.add_effect_with_name('wsnap-blur', effect);
            this.add_child(this._frost);
        }
        this._glass = new St.Widget({style_class: styleClass});
        this.add_child(this._glass);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const w = box.get_width(), h = box.get_height();
        const full = new Clutter.ActorBox();
        full.set_origin(0, 0);
        full.set_size(w, h);
        this._glass.allocate(full);
        if (this._frost) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const inset = FROST_INSET * scale;
            const frostBox = new Clutter.ActorBox();
            frostBox.set_origin(inset, inset);
            frostBox.set_size(Math.max(0, w - 2 * inset), Math.max(0, h - 2 * inset));
            this._frost.allocate(frostBox);
        }
    }

    setTint(style) {
        this._glass.set_style(style);
    }
});

export const SnapPreview = GObject.registerClass(
class SnapPreview extends FrostedPanel {
    _init(ext) {
        super._init({styleClass: 'wsnap-preview', blur: true});
        this._ext = ext;
        this._rect = null;
        this._showing = false;
        this.visible = false;
        global.window_group.add_child(this);
        this.updateColors();
    }

    updateColors() {
        const [r, g, b] = accentRgb();
        this.setTint(`background-color: rgba(${r}, ${g}, ${b}, 0.24); ` +
            `border-color: rgba(${r}, ${g}, ${b}, 0.85);`);
    }

    get showing() {
        return this._showing;
    }

    /**
     * Show (or move) the preview over `rect` (already inset), stacked just
     * below `window`. `origin` = [x, y] the preview grows out of.
     */
    open(window, rect, origin) {
        const actor = window?.get_compositor_private();
        if (actor && actor.get_parent() === global.window_group)
            global.window_group.set_child_below_sibling(this, actor);
        else
            global.window_group.set_child_above_sibling(this, null);

        if (this._rect && this._showing &&
            this._rect.x === rect.x && this._rect.y === rect.y &&
            this._rect.width === rect.width && this._rect.height === rect.height)
            return;
        this._rect = rect;
        const motion = this._ext.motion;

        if (!this._showing) {
            this._showing = true;
            // Grow out of the pointer, clamped inside the target.
            const [ox, oy] = origin ?? [rect.x + rect.width / 2, rect.y + rect.height / 2];
            const w0 = rect.width * 0.35, h0 = rect.height * 0.35;
            const cx = Math.min(Math.max(ox, rect.x + w0 / 2), rect.x + rect.width - w0 / 2);
            const cy = Math.min(Math.max(oy, rect.y + h0 / 2), rect.y + rect.height - h0 / 2);
            this.remove_all_transitions();
            this.set_position(Math.round(cx - w0 / 2), Math.round(cy - h0 / 2));
            this.set_size(Math.round(w0), Math.round(h0));
            this.opacity = 0;
            this.show();
            motion.ease(this, {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                opacity: 255,
                duration: SHOW_MS,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        } else {
            motion.ease(this, {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                opacity: 255,
                duration: MORPH_MS,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        }
    }

    /** Hide. `toward` = [x, y] to shrink toward (the pointer), or null to just fade. */
    close(toward = null) {
        if (!this._showing)
            return;
        this._showing = false;
        this._rect = null;
        const params = {
            opacity: 0,
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (!this._showing)
                    this.hide();
            },
        };
        if (toward) {
            const [w, h] = this.get_size();
            const w1 = w * 0.6, h1 = h * 0.6;
            const [px, py] = toward;
            const [x, y] = this.get_position();
            Object.assign(params, {
                x: Math.round(x + (px - x) * 0.4),
                y: Math.round(y + (py - y) * 0.4),
                width: Math.round(w1),
                height: Math.round(h1),
            });
        }
        this._ext.motion.ease(this, params);
    }

    /** Hide immediately (the window took the preview's place). */
    dismiss() {
        this._showing = false;
        this._rect = null;
        this._ext.motion.ease(this, {
            opacity: 0,
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (!this._showing)
                    this.hide();
            },
        });
    }
});
