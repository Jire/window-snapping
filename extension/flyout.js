// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The snap layouts flyout (Super+Z, like Win+Z): opens at the focused
// window's top-right corner, where Windows shows it under the maximize
// button. Layouts are numbered: press a layout's number, then a zone's
// number. Arrow keys + Enter and the mouse work too; Esc closes.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Acrylic} from './acrylic.js';
import {styleVariant, vbox} from './compat.js';
import * as G from './geometry.js';
import {LayoutPicker} from './layoutPicker.js';
import {isSnappable} from './snapper.js';

const OPEN_MS = 160;
const MARGIN = 8;

const DIGITS = [
    Clutter.KEY_1, Clutter.KEY_2, Clutter.KEY_3, Clutter.KEY_4, Clutter.KEY_5,
    Clutter.KEY_6, Clutter.KEY_7, Clutter.KEY_8, Clutter.KEY_9,
];
const KP_DIGITS = [
    Clutter.KEY_KP_1, Clutter.KEY_KP_2, Clutter.KEY_KP_3, Clutter.KEY_KP_4, Clutter.KEY_KP_5,
    Clutter.KEY_KP_6, Clutter.KEY_KP_7, Clutter.KEY_KP_8, Clutter.KEY_KP_9,
];

export class LayoutFlyout {
    constructor(ext) {
        this._ext = ext;
        this._ui = null;
    }

    destroy() {
        this.close(false);
    }

    get isOpen() {
        return !!this._ui;
    }

    updateColors() {
        if (!this._ui)
            return;
        this._ui.picker.updateColors();
        this._applyStyle();
    }

    toggle(win) {
        if (this._ui) {
            this.close();
            return;
        }
        if (!win || !isSnappable(win) || Main.overview.visible)
            return;
        this._ext.assist.dismiss();
        this._open(win);
    }

    _open(win) {
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitor = win.get_monitor();
        const wa = this._ext.snapper.workArea(monitor, win);
        const layouts = G.layoutsFor(wa);

        const overlay = new St.Widget({
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        Main.layoutManager.uiGroup.add_child(overlay);

        const panel = new Acrylic({radius: 16, styleClass: 'wsnap-flyout-panel'});
        overlay.add_child(panel);
        const content = vbox({style_class: 'wsnap-flyout-content'});
        const picker = new LayoutPicker({
            layouts,
            aspect: wa.width / wa.height,
            columns: layouts.length > 4 ? 3 : 2,
            reactive: true,
        });
        const hint = new St.Label({style_class: 'wsnap-flyout-title', x_align: Clutter.ActorAlign.CENTER});
        content.add_child(picker);
        content.add_child(hint);
        overlay.add_child(content);

        this._ui = {win, monitor, overlay, panel, content, picker, hint, layouts, mode: 'layouts', active: -1, focus: null};
        this._applyStyle();
        this._setMode('layouts');

        // Size and place: under the window's top-right corner.
        const [, natW] = content.get_preferred_width(-1);
        const [, natH] = content.get_preferred_height(natW);
        const f = win.get_frame_rect();
        let x = f.x + f.width - natW - MARGIN * s;
        let y = f.y + 44 * s;
        x = Math.round(Math.min(Math.max(x, wa.x + MARGIN * s), wa.x + wa.width - natW - MARGIN * s));
        y = Math.round(Math.min(Math.max(y, wa.y + MARGIN * s), wa.y + wa.height - natH - MARGIN * s));
        for (const a of [panel, content]) {
            a.set_position(x, y);
            a.set_size(natW, natH);
        }

        picker.connect('zone-activated', (p, li, zi) => this._choose(li, zi));
        overlay.connect('button-release-event', (a, event) => {
            const [ex, ey] = event.get_coords();
            if (ex < x || ex >= x + natW || ey < y || ey >= y + natH)
                this.close();
            return Clutter.EVENT_STOP;
        });
        overlay.connect('key-press-event', (a, event) => this._onKey(event));

        this._ui.grab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.POPUP});
        const seatState = this._ui.grab.get_seat_state?.();
        if (seatState !== undefined && !(seatState & Clutter.GrabState.KEYBOARD)) {
            this.close(false);
            return;
        }
        overlay.grab_key_focus();

        const motion = this._ext.motion;
        for (const a of [panel, content]) {
            a.opacity = 0;
            a.translation_y = -8 * s;
            motion.ease(a, {
                opacity: 255,
                translation_y: 0,
                duration: OPEN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        }
        win.connectObject('unmanaging', () => this.close(false), this);
    }

    _applyStyle() {
        const ui = this._ui;
        const light = styleVariant(Main) === 'light';
        ui.overlay[light ? 'add_style_class_name' : 'remove_style_class_name']('wsnap-light');
        ui.panel.setTint(light
            ? 'background-color: rgba(250, 250, 251, 0.80);'
            : 'background-color: rgba(38, 38, 42, 0.78);');
    }

    _setMode(mode, layoutIndex = -1) {
        const ui = this._ui;
        ui.mode = mode;
        ui.active = layoutIndex;
        ui.picker.setNumbering(mode, layoutIndex);
        const count = mode === 'layouts' ? ui.layouts.length : ui.layouts[layoutIndex].zones.length;
        ui.hint.text = mode === 'layouts'
            ? `Press 1–${count} to pick a layout`
            : `Press 1–${count} to snap · Backspace to go back`;
    }

    _onKey(event) {
        if (this._ext.keyboard?.forward(event))
            return Clutter.EVENT_STOP;
        const ui = this._ui;
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        let digit = DIGITS.indexOf(key);
        if (digit < 0)
            digit = KP_DIGITS.indexOf(key);
        if (digit >= 0) {
            if (ui.mode === 'layouts' && digit < ui.layouts.length) {
                this._setMode('zones', digit);
                ui.focus = [digit, 0];
                ui.picker.setHover(digit, 0);
            } else if (ui.mode === 'zones' && digit < ui.layouts[ui.active].zones.length) {
                this._choose(ui.active, digit);
            }
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_BackSpace && ui.mode === 'zones') {
            this._setMode('layouts');
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || key === Clutter.KEY_space) {
            const f = ui.focus ?? ui.picker.hover;
            if (f)
                this._choose(f[0], f[1]);
            return Clutter.EVENT_STOP;
        }
        const step = {
            [Clutter.KEY_Right]: 1, [Clutter.KEY_Down]: 1, [Clutter.KEY_Tab]: 1,
            [Clutter.KEY_Left]: -1, [Clutter.KEY_Up]: -1, [Clutter.KEY_ISO_Left_Tab]: -1,
        }[key];
        if (step) {
            // Walk through every zone of every layout (or of the chosen one).
            const all = [];
            ui.layouts.forEach((l, li) => {
                if (ui.mode === 'zones' && li !== ui.active)
                    return;
                l.zones.forEach((z, zi) => all.push([li, zi]));
            });
            const cur = ui.focus ? all.findIndex(([a, b]) => a === ui.focus[0] && b === ui.focus[1]) : -1;
            const next = all[(cur + step + all.length) % all.length];
            ui.focus = next;
            ui.picker.setHover(...next);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _choose(layoutIndex, zoneIndex) {
        const ui = this._ui;
        if (!ui)
            return;
        const {win, monitor} = ui;
        const layout = ui.layouts[layoutIndex];
        this.close();
        const record = this._ext.snapper.snap(win, layout.zones[zoneIndex], monitor, {
            fill: false,
            layoutId: layout.id,
        });
        win.activate(global.get_current_time());
        if (record)
            this._ext.assist.afterLayoutSnap(record, layout, zoneIndex);
    }

    close(animate = true) {
        const ui = this._ui;
        if (!ui)
            return;
        this._ui = null;
        ui.win.disconnectObject(this);
        if (ui.grab)
            Main.popModal(ui.grab);
        ui.overlay.reactive = false;
        if (!animate) {
            ui.overlay.destroy();
            return;
        }
        this._ext.motion.ease(ui.overlay, {
            opacity: 0,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => ui.overlay.destroy(),
        });
    }
}
