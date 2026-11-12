// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Windows 11's "snap bar": while a window is dragged near the top of a
// screen, a strip peeks down from the top centre. Drag onto it and it opens
// into the snap layouts; hover a zone to preview it full size, drop to snap.
// The rest of the top edge still maximizes.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as G from './geometry.js';
import {LayoutPicker} from './layoutPicker.js';
import {FrostedPanel} from './preview.js';
import {styleVariant} from './compat.js';

const PEEK = 10; // px of the collapsed bar showing below the top edge
const OPEN_TOP = 10; // gap above the open bar
const PADDING = 12;
const SLIDE_MS = 220;
// The open bar stays open while the pointer is this close to it.
const KEEP_SIDE = 28;
const KEEP_BELOW = 64;

export class SnapBar {
    constructor(ext, controller) {
        this._ext = ext;
        this._controller = controller;
        this._monitor = -1;
        this._state = 'hidden'; // 'hint' | 'open'
        this._actor = null;
        this._panel = null;
        this._picker = null;
        this._size = [0, 0];
    }

    destroy() {
        this._destroyActor();
    }

    updateColors() {
        this._picker?.updateColors();
        this._applyStyle();
    }

    _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    _build(monitor) {
        this._destroyActor();
        this._monitor = monitor;
        const wa = this._ext.snapper.workArea(monitor);
        const layouts = G.layoutsFor(wa);
        const s = this._scale();

        this._actor = new St.Widget({reactive: false, visible: false});
        this._panel = new FrostedPanel({styleClass: 'wsnap-bar', blur: true});
        this._picker = new LayoutPicker({layouts, aspect: wa.width / wa.height, reactive: false});
        this._actor.add_child(this._panel);
        this._actor.add_child(this._picker);
        Main.layoutManager.uiGroup.add_child(this._actor);

        const [, natW] = this._picker.get_preferred_width(-1);
        const [, natH] = this._picker.get_preferred_height(natW);
        const w = Math.round(natW + 2 * PADDING * s), h = Math.round(natH + 2 * PADDING * s);
        this._size = [w, h];
        this._actor.set_size(w, h);
        this._panel.set_size(w, h);
        this._picker.set_position(Math.round(PADDING * s), Math.round(PADDING * s));
        this._picker.set_size(natW, natH);
        this._applyStyle();

        const mon = Main.layoutManager.monitors[monitor];
        this._actor.set_position(Math.round(mon.x + (mon.width - w) / 2), mon.y);
        this._actor.translation_y = -h;
        this._state = 'hidden';
    }

    _applyStyle() {
        if (!this._actor)
            return;
        const light = styleVariant(Main) === 'light';
        for (const a of [this._actor, this._picker])
            a[light ? 'add_style_class_name' : 'remove_style_class_name']('wsnap-light');
        this._panel.setTint(light
            ? 'background-color: rgba(250, 250, 251, 0.78);'
            : 'background-color: rgba(38, 38, 42, 0.74);');
    }

    _destroyActor() {
        this._actor?.destroy();
        this._actor = null;
        this._panel = null;
        this._picker = null;
        this._monitor = -1;
        this._state = 'hidden';
    }

    _setState(state) {
        if (this._state === state || !this._actor)
            return;
        this._state = state;
        const s = this._scale();
        const [, h] = this._size;
        const motion = this._ext.motion;
        let y, pickerOpacity;
        switch (state) {
        case 'hint':
            y = -h + PEEK * s;
            pickerOpacity = 0;
            break;
        case 'open':
            y = OPEN_TOP * s;
            pickerOpacity = 255;
            break;
        default:
            y = -h;
            pickerOpacity = 0;
        }
        if (state !== 'hidden')
            this._actor.show();
        if (state !== 'open')
            this._picker.setHover(-1, -1);
        motion.ease(this._actor, {
            translation_y: y,
            duration: SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            onStopped: () => {
                if (this._state === 'hidden')
                    this._actor?.hide();
            },
        });
        motion.ease(this._picker, {
            opacity: pickerOpacity,
            duration: state === 'open' ? SLIDE_MS : 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Bar geometry in stage coordinates for the open state. */
    _openRect() {
        const [w, h] = this._size;
        const [x] = this._actor.get_position();
        const mon = Main.layoutManager.monitors[this._monitor];
        return G.rect(x, mon.y + OPEN_TOP * this._scale(), w, h);
    }

    /**
     * Follow the pointer during a drag. Returns null when the bar isn't
     * involved, {blocksTop: true} when the pointer is on the bar (so the top
     * edge must not maximize), or a layout zone target when one is hovered.
     */
    update(x, y, monitor, _win) {
        const mon = Main.layoutManager.monitors[monitor];
        if (!mon)
            return null;
        const s = this._scale();
        if (monitor !== this._monitor)
            this._build(monitor);

        const [w] = this._size;
        const hintZone = Math.min(Math.max(mon.height * 0.16, 120 * s), 220 * s);
        const [bx] = this._actor.get_position();
        const inSpan = x >= bx - KEEP_SIDE * s && x < bx + w + KEEP_SIDE * s;

        if (this._state === 'open') {
            const r = this._openRect();
            const keep = x >= r.x - KEEP_SIDE * s && x < r.x + r.width + KEEP_SIDE * s &&
                y >= mon.y && y < r.y + r.height + KEEP_BELOW * s;
            if (keep) {
                const hit = this._picker.zoneAt(x, y);
                this._picker.setHover(...(hit ?? [-1, -1]));
                if (!hit)
                    return {blocksTop: true};
                const layout = this._picker.layouts[hit[0]];
                return {
                    blocksTop: true,
                    monitor,
                    layout,
                    zoneIndex: hit[1],
                    zone: layout.zones[hit[1]],
                };
            }
        }

        if (y - mon.y > hintZone) {
            this._setState('hidden');
            return null;
        }
        // Touching the top edge on the bar opens it.
        if (inSpan && y <= mon.y + Math.max(PEEK + 14, 24) * s) {
            this._setState('open');
            return {blocksTop: true};
        }
        this._setState('hint');
        return null;
    }

    /** Hide at the end of a drag. */
    hide(animate = true) {
        if (!this._actor)
            return;
        if (!animate) {
            this._destroyActor();
            return;
        }
        this._setState('hidden');
    }
}
