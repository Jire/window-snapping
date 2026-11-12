// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Resizing, Windows-style:
//
//  - Joint resize: drag the edge between snapped windows and every snapped
//    window on that line follows, so the layout stays tidy. While they catch
//    up, the windows being resized show a frosted placeholder with their app
//    icon (like Windows 11 does), so you never see half-drawn frames.
//  - Vertical maximize: drag a window's top or bottom edge to the edge of
//    the screen to stretch it to full height, keeping its width.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Compat from './compat.js';
import * as G from './geometry.js';
import {FrostedPanel, insetRect} from './preview.js';
import {monitorAt} from './dragSnap.js';

const DIR_W = 0x1000, DIR_E = 0x2000, DIR_S = 0x4000, DIR_N = 0x8000;
const KEYBOARD = 0x100;
// Edges this close (px, plus the gap) count as touching.
const TOUCH = 6;
const VEIL_FADE_MS = 180;
// After the grab ends, give the partner windows this long to redraw.
const VEIL_LINGER_MS = 160;

function isMouseResize(op) {
    return (op & (DIR_W | DIR_E | DIR_S | DIR_N)) !== 0 && (op & KEYBOARD) === 0;
}

function frameOf(win) {
    return G.rectFromMtk(win.get_frame_rect());
}

/** Frosted placeholder with the app icon, laid over a window being resized. */
class Veil {
    constructor(ext, win) {
        this._ext = ext;
        this.win = win;
        const actor = win.get_compositor_private();
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: false});
        this.actor.offscreen_redirect = Clutter.OffscreenRedirect.NEVER;
        this._glass = new FrostedPanel({styleClass: 'wsnap-veil', blur: true});
        this._glass.x_expand = this._glass.y_expand = true;
        this.actor.add_child(this._glass);
        const light = Compat.styleVariant(Main) === 'light';
        this._glass.setTint(light
            ? 'background-color: rgba(250, 250, 251, 0.55);'
            : 'background-color: rgba(36, 36, 40, 0.50);');
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const icon = app?.create_icon_texture(64 * s);
        if (icon) {
            icon.x_align = Clutter.ActorAlign.CENTER;
            icon.y_align = Clutter.ActorAlign.CENTER;
            icon.x_expand = icon.y_expand = true;
            this.actor.add_child(icon);
        }
        if (actor?.get_parent() === global.window_group) {
            global.window_group.add_child(this.actor);
            global.window_group.set_child_above_sibling(this.actor, actor);
        } else {
            Main.layoutManager.uiGroup.add_child(this.actor);
        }
        this.follow(frameOf(win));
        this.actor.opacity = 0;
        ext.motion.ease(this.actor, {opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    follow(rect) {
        this.actor.set_position(rect.x, rect.y);
        this.actor.set_size(rect.width, rect.height);
    }

    dismiss() {
        this._ext.motion.ease(this.actor, {
            opacity: 0,
            duration: VEIL_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this.actor.destroy(),
        });
    }

    destroy() {
        this.actor.destroy();
    }
}

export class ResizeController {
    constructor(ext) {
        this._ext = ext;
        this._session = null;
        this._lingering = new Set();
        global.display.connectObject(
            'grab-op-begin', (d, win, op) => this._onGrabBegin(win, op),
            'grab-op-end', (d, win, op) => this._onGrabEnd(win, op),
            this);
    }

    destroy() {
        this._end(false);
        for (const id of this._lingering)
            GLib.source_remove(id);
        this._lingering.clear();
        global.display.disconnectObject(this);
    }

    isResizing(win) {
        return this._session?.win === win;
    }

    updateColors() {}

    _onGrabBegin(win, op) {
        if (!isMouseResize(op))
            return;
        this._end(false);
        const record = this._ext.snapper.recordFor(win);
        if (record) {
            // A half is vertically maximized (to look tiled); let its
            // top/bottom edges move if that's what's being dragged.
            if (op & (DIR_N | DIR_S))
                this._ext.snapper.unlockForResize(win, true);
            if (op & (DIR_W | DIR_E))
                this._ext.snapper.unlockForResize(win, false);
        }
        if (record && this._ext.settings.get_boolean('joint-resize'))
            this._beginJoint(win, op, record);
        else if (!record && Compat.maximizeFlags(win) === 0 && (op & (DIR_N | DIR_S)) &&
                 this._ext.settings.get_boolean('snap-on-drag') && win.can_maximize())
            this._beginVertical(win, op);
    }

    _onGrabEnd(win) {
        if (this._session?.win === win)
            this._end(true);
    }

    // -- Joint resize --------------------------------------------------------

    _beginJoint(win, op, record) {
        const snapper = this._ext.snapper;
        const f = frameOf(win);
        const gap = snapper.gap;
        const tol = TOUCH + gap;
        const others = snapper.snappedOn(record.monitor, win.get_workspace(), {exclude: win});

        // For each edge being dragged, find the snapped windows on the same
        // line: the ones across the seam move their facing edge, the ones on
        // the same side (e.g. the bottom-left quarter when the top-left one's
        // right edge is dragged) move the same edge, keeping the grid tidy.
        const AXIS = {left: 'x', right: 'x', top: 'y', bottom: 'y'};
        const FACING = {left: 'right', right: 'left', top: 'bottom', bottom: 'top'};
        const followersOf = (edge, pos) => {
            const forward = edge === 'right' || edge === 'bottom';
            const out = [];
            for (const r of others) {
                const o = r.rect ?? frameOf(r.win);
                const lo = AXIS[edge] === 'x' ? o.x : o.y;
                const hi = AXIS[edge] === 'x' ? o.x + o.width : o.y + o.height;
                const facingEdge = forward ? lo : hi;
                const sameEdge = forward ? hi : lo;
                if (Math.abs(facingEdge - (forward ? pos + gap : pos - gap)) <= tol)
                    out.push({record: r, edge: FACING[edge], facing: true});
                else if (Math.abs(sameEdge - pos) <= tol)
                    out.push({record: r, edge, facing: false});
            }
            return out;
        };
        const lines = [];
        if (op & DIR_E)
            lines.push({edge: 'right', followers: followersOf('right', f.x + f.width)});
        if (op & DIR_W)
            lines.push({edge: 'left', followers: followersOf('left', f.x)});
        if (op & DIR_S)
            lines.push({edge: 'bottom', followers: followersOf('bottom', f.y + f.height)});
        if (op & DIR_N)
            lines.push({edge: 'top', followers: followersOf('top', f.y)});

        const followers = lines.flatMap(l => l.followers);
        this._session = {
            kind: 'joint',
            win,
            record,
            lines,
            start: f,
            veils: new Map(),
            laterId: 0,
        };
        for (const {record: r} of followers) {
            if (!this._session.veils.has(r.win))
                this._session.veils.set(r.win, new Veil(this._ext, r.win));
        }
        win.connectObject('size-changed', () => this._queueJoint(), this);
        this._ext.log(`joint resize: ${followers.length} window(s) follow`);
    }

    _queueJoint() {
        const s = this._session;
        if (!s || s.laterId)
            return;
        s.laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            s.laterId = 0;
            this._applyJoint();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyJoint() {
        const s = this._session;
        if (!s || s.kind !== 'joint')
            return;
        const snapper = this._ext.snapper;
        const gap = snapper.gap;
        const f = frameOf(s.win);
        const pending = new Map();
        const rectFor = r => pending.get(r) ?? {...(r.rect ?? frameOf(r.win))};
        for (const line of s.lines) {
            let pos;
            switch (line.edge) {
            case 'right': pos = f.x + f.width; break;
            case 'left': pos = f.x; break;
            case 'bottom': pos = f.y + f.height; break;
            default: pos = f.y;
            }
            const forward = line.edge === 'right' || line.edge === 'bottom';
            for (const {record: r, edge, facing} of line.followers) {
                const o = rectFor(r);
                const right = o.x + o.width, bottom = o.y + o.height;
                const p = facing ? (forward ? pos + gap : pos - gap) : pos;
                switch (edge) {
                case 'left': o.x = p; o.width = right - p; break;
                case 'right': o.width = p - o.x; break;
                case 'top': o.y = p; o.height = bottom - p; break;
                default: o.height = p - o.y;
                }
                if (o.width >= 48 && o.height >= 48)
                    pending.set(r, o);
            }
        }
        for (const [r, rect] of pending) {
            snapper.resizeSnapped(r, rect);
            s.veils.get(r.win)?.follow(rect);
        }
    }

    _finishJoint(s) {
        const snapper = this._ext.snapper;
        if (s.laterId) {
            global.compositor.get_laters().remove(s.laterId);
            s.laterId = 0;
        }
        this._applyJoint();
        // The grabbed window: still snapped if its outer edges still touch
        // the work area where its zone did; otherwise it's floating now.
        const record = snapper.recordFor(s.win);
        if (record) {
            const wa = snapper.workArea(record.monitor, s.win);
            const f = frameOf(s.win);
            const gap = snapper.gap;
            const tol = TOUCH + gap;
            const z = record.zone;
            const ok = (z.x > 1e-3 || Math.abs(f.x - wa.x) <= tol) &&
                (z.y > 1e-3 || Math.abs(f.y - wa.y) <= tol) &&
                (z.x + z.w < 1 - 1e-3 || Math.abs(f.x + f.width - (wa.x + wa.width)) <= tol) &&
                (z.y + z.h < 1 - 1e-3 || Math.abs(f.y + f.height - (wa.y + wa.height)) <= tol);
            if (ok)
                snapper.adopt(record);
            else
                snapper.release(s.win);
        }
        for (const line of s.lines) {
            for (const {record: r} of line.followers) {
                if (snapper.recordFor(r.win) === r)
                    snapper.adopt(r);
            }
        }
        // Let the windows that followed redraw before revealing them.
        const veils = [...s.veils.values()];
        if (!veils.length)
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VEIL_LINGER_MS, () => {
            this._lingering.delete(id);
            for (const veil of veils)
                veil.dismiss();
            return GLib.SOURCE_REMOVE;
        });
        this._lingering.add(id);
    }

    // -- Vertical maximize ---------------------------------------------------

    _beginVertical(win, op) {
        this._session = {kind: 'vertical', win, op, active: false};
        this._session.unwatch = Compat.watchPointer(() => this._updateVertical());
        win.connectObject('size-changed', () => this._updateVertical(), this);
    }

    _updateVertical() {
        const s = this._session;
        if (!s || s.kind !== 'vertical')
            return;
        const [x, y] = global.get_pointer();
        const monitor = monitorAt(x, y);
        const m = Main.layoutManager.monitors[monitor];
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const edge = 4 * scale;
        const hit = ((s.op & DIR_N) && y <= m.y + edge) ||
            ((s.op & DIR_S) && y >= m.y + m.height - 1 - edge);
        const preview = this._ext.drag?.preview;
        if (hit) {
            const wa = this._ext.snapper.workArea(monitor, s.win);
            const f = frameOf(s.win);
            s.active = true;
            s.monitor = monitor;
            preview?.open(s.win, insetRect(G.rect(f.x, wa.y, f.width, wa.height), wa, scale), [x, y]);
        } else if (s.active) {
            s.active = false;
            preview?.close([x, y]);
        }
    }

    _finishVertical(s, commit) {
        s.unwatch();
        const preview = this._ext.drag?.preview;
        if (!s.active)
            return;
        preview?.dismiss();
        if (!commit)
            return;
        const win = s.win;
        // Mutter keeps the width and makes it full height, like Windows.
        this._ext.morphs.run(win, () => {
            const actor = win.get_compositor_private();
            if (actor)
                Main.wm.skipNextEffect(actor);
            Compat.maximizeFlagsSet(win, Meta.MaximizeFlags.VERTICAL);
        });
    }

    // ------------------------------------------------------------------------

    _end(commit) {
        const s = this._session;
        if (!s)
            return;
        this._session = null;
        s.win.disconnectObject(this);
        if (s.kind === 'joint') {
            if (commit) {
                this._finishJoint(s);
            } else {
                for (const veil of s.veils.values())
                    veil.destroy();
            }
        } else {
            const cancelled = (global.get_pointer()[2] & Clutter.ModifierType.BUTTON1_MASK) !== 0;
            this._finishVertical(s, commit && !cancelled);
        }
    }
}
