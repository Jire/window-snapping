// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The translucent "this is where the window will go" overlay shown while
// dragging, like Windows 11's snap preview: frosted glass tinted with the
// accent colour, drawn *under* the window being dragged, growing out from the
// pointer and gliding between zones as the pointer moves.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {Acrylic} from './acrylic.js';
import {accentRgb} from './compat.js';
import {typeName} from './gtype.js';

const SHOW_MS = 220;
const MORPH_MS = 200;
const HIDE_MS = 140;
// Gap between the preview and the work area's outer edges / between zones.
export const OUTER_INSET = 8;
export const INNER_INSET = 4;
const RADIUS = 12;

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

export const SnapPreview = GObject.registerClass({GTypeName: typeName('SnapPreview')},
class SnapPreview extends Acrylic {
    _init(ext) {
        super._init({radius: RADIUS, styleClass: 'wsnap-preview'});
        this._ext = ext;
        this._rect = null;
        this._showing = false;
        this._window = null;
        this.visible = false;
        global.window_group.add_child(this);
        this.updateColors();
        // Mutter restacks windows by lowering each one to the bottom, which
        // leaves this above all of them: put it back under the dragged window.
        global.display.connectObject('restacked', () => {
            if (this.visible)
                this._restack();
        }, this);
    }

    updateColors() {
        const [r, g, b] = accentRgb();
        this.setTint(`background-color: rgba(${r}, ${g}, ${b}, 0.24); ` +
            `border-color: rgba(${r}, ${g}, ${b}, 0.85);`);
    }

    /** Stack just below the dragged window, so the glass shows what's behind both. */
    _restack() {
        if (!this._window)
            return;
        const group = global.window_group;
        const actor = this._window.get_compositor_private();
        const below = actor?.get_parent() === group ? actor : null;
        if (below ? this.get_next_sibling() === below : group.get_last_child() === this)
            return;
        if (below)
            group.set_child_below_sibling(this, below);
        else
            group.set_child_above_sibling(this, null);
        this.refresh();
    }

    get showing() {
        return this._showing;
    }

    /**
     * Show (or move) the preview over `rect` (already inset), stacked just
     * below `window`. `origin` = [x, y] the preview grows out of.
     */
    open(window, rect, origin) {
        this._window = window;
        this._restack();

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
            onStopped: () => this._hidden(),
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
            onStopped: () => this._hidden(),
        });
    }

    _hidden() {
        if (this._showing)
            return;
        this.hide();
        this._window = null;
    }
});
