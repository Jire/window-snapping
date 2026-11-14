// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Snapping by dragging a window by its title bar, like Windows 11:
//
//  - left/right edge: half of the screen; corners: quarters; top edge:
//    maximize. The preview glides between zones as the pointer moves.
//  - near the top centre, the snap layouts bar drops down (snapBar.js);
//    dropping the window on one of its zones snaps it there.
//  - dragging a snapped or maximized window restores its original size
//    straight away, keeping the pointer at the same spot of the title bar.
//  - Esc while dragging cancels: the window goes back where it was, snapped
//    or maximized as before.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Compat from './compat.js';
import * as G from './geometry.js';
import {SnapPreview, insetRect} from './preview.js';
import {SnapBar} from './snapBar.js';
import {isSnappable} from './snapper.js';

// With "snap before reaching the edge" on, this close (logical px) counts.
const EDGE_NEAR = 32;
// With it off the pointer has to touch the edge, except on an edge shared
// with another monitor, where it can't stop: allow this much there.
const EDGE_SHARED = 8;
// Corner zones reach this far along each edge (fraction of the monitor's
// shorter side, clamped).
const CORNER_FRACTION = 0.12;
const CORNER_MIN = 72;
const CORNER_MAX = 240;

const MOVE_OPS = [Meta.GrabOp.MOVING, Meta.GrabOp.MOVING_UNCONSTRAINED].filter(op => op !== undefined);

export function isMouseMove(op) {
    return MOVE_OPS.includes(op);
}

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function pointer() {
    const [x, y, mods] = global.get_pointer();
    return {x, y, mods};
}

export function monitorAt(x, y) {
    const rect = new Mtk.Rectangle({x: Math.round(x), y: Math.round(y), width: 1, height: 1});
    const index = global.display.get_monitor_index_for_rect(rect);
    return index >= 0 ? index : global.display.get_current_monitor();
}

function monitorRect(index) {
    const m = Main.layoutManager.monitors[index];
    return m ? G.rect(m.x, m.y, m.width, m.height) : null;
}

/** Is this point of a monitor's edge shared with another monitor? */
function sharedEdge(index, side, x, y) {
    const mon = monitorRect(index);
    for (const [i, m] of Main.layoutManager.monitors.entries()) {
        if (i === index)
            continue;
        if (side === 'left' && m.x + m.width === mon.x && y >= m.y && y < m.y + m.height)
            return true;
        if (side === 'right' && m.x === mon.x + mon.width && y >= m.y && y < m.y + m.height)
            return true;
        if (side === 'top' && m.y + m.height === mon.y && x >= m.x && x < m.x + m.width)
            return true;
        if (side === 'bottom' && m.y === mon.y + mon.height && x >= m.x && x < m.x + m.width)
            return true;
    }
    return false;
}

class DragSession {
    constructor(win, op) {
        this.win = win;
        this.op = op;
        const p = pointer();
        this.startX = p.x;
        this.startY = p.y;
        this.armed = false; // moved far enough to start snapping
        this.target = null; // {kind: 'edge'|'layout', zone, monitor, name?, layout?}
        this.restoredFrom = null; // snap record / maximized state before the drag
        // Where the window was before the drag: what it goes back to when
        // it's unsnapped later (if it was floating).
        this.startRect = G.rectFromMtk(win.get_frame_rect());
    }
}

export class DragController {
    constructor(ext) {
        this._ext = ext;
        this._session = null;
        this.preview = new SnapPreview(ext);
        this._bar = new SnapBar(ext, this);
        this._unwatch = null;

        global.display.connectObject(
            'grab-op-begin', (d, win, op) => this._onGrabBegin(win, op),
            'grab-op-end', (d, win, op) => this._onGrabEnd(win, op),
            this);
    }

    destroy() {
        this._endSession();
        global.display.disconnectObject(this);
        this._bar.destroy();
        this.preview.destroy();
    }

    /** Look at the pointer again, though it hasn't moved. */
    refresh() {
        this._update();
    }

    isDragging(win) {
        return this._session?.win === win;
    }

    updateColors() {
        this.preview.updateColors();
        this._bar.updateColors();
    }

    // -- Grab handling -------------------------------------------------------

    _onGrabBegin(win, op) {
        if (!isMouseMove(op) || !isSnappable(win))
            return;
        this._endSession();
        const session = new DragSession(win, op);
        this._session = session;

        this._restoreForDrag(session);

        if (!this._ext.settings.get_boolean('snap-on-drag'))
            return;
        this._unwatch = Compat.watchPointer(() => this._update());
        win.connectObject(
            'position-changed', () => this._update(),
            'unmanaging', () => this._endSession(),
            this);
        this._update();
    }

    _onGrabEnd(win, op) {
        const session = this._session;
        if (!session || session.win !== win)
            return;
        this._endSession();
        if (!isMouseMove(op))
            return;

        // Esc ends the grab while the button is still held; a drop releases it.
        const cancelled = (pointer().mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
        const target = session.target;
        this._bar.hide(!target || target.kind !== 'layout');

        if (cancelled) {
            this.preview.close();
            this._restoreAfterCancel(session);
            return;
        }
        if (!target) {
            this.preview.close();
            return;
        }

        this.preview.dismiss();
        const snapper = this._ext.snapper;
        // Unsnapping later restores the geometry from before it was first
        // snapped or maximized, not where it was dropped.
        const from = session.restoredFrom;
        const restore = from?.record?.restore ?? (from ? null : session.startRect);
        if (target.kind === 'edge' && target.name === 'maximize') {
            snapper.maximize(win, target.monitor, {restore});
            return;
        }
        const record = snapper.snap(win, target.zone, target.monitor, {
            layoutId: target.layout?.id ?? null,
            restore: restore ?? undefined,
        });
        if (!record)
            return;
        if (target.kind === 'layout')
            this._ext.assist.afterLayoutSnap(record, target.layout, target.zoneIndex);
        else
            this._ext.assist.afterSnap(record);
    }

    _endSession() {
        if (!this._session)
            return;
        this._unwatch?.();
        this._unwatch = null;
        this._session.win.disconnectObject(this);
        this._session = null;
    }

    // -- Restoring snapped/maximized windows as the drag starts --------------

    _restoreForDrag(session) {
        const win = session.win;
        const snapper = this._ext.snapper;
        const record = snapper.recordFor(win);
        const flags = Compat.maximizeFlags(win);
        if (!record && flags === 0)
            return;

        // Keep the pointer on the same spot of the title bar: the same
        // fraction across, the same fraction down (this is also how Mutter
        // keeps positioning the window for the rest of the drag).
        const f = win.get_frame_rect();
        const p = pointer();
        const relX = Math.min(Math.max((p.x - f.x) / Math.max(1, f.width), 0), 1);
        const relY = Math.min(Math.max((p.y - f.y) / Math.max(1, f.height), 0), 1);
        const restore = snapper.restoreRectFor(win);
        const width = restore.width, height = restore.height;
        const rect = G.rect(Math.round(p.x - width * relX), Math.round(p.y - height * relY), width, height);

        session.restoredFrom = {
            record: record ? {
                zone: record.zone,
                monitor: record.monitor,
                layoutId: record.layoutId,
                restore: record.restore,
            } : null,
            flags,
            rect: G.rectFromMtk(f),
        };
        this._ext.log(`drag: restoring ${win.get_title()} to ${width}×${height}`);
        snapper.unsnap(win, {rect, animate: false});
    }

    _restoreAfterCancel(session) {
        const from = session.restoredFrom;
        if (!from)
            return;
        const win = session.win;
        if (from.record) {
            // Mutter moves the window back to where the drag started, which
            // is its zone: mark it snapped again.
            const record = this._ext.snapper.snap(win, from.record.zone, from.record.monitor, {
                animate: false,
                fill: false,
                layoutId: from.record.layoutId,
            });
            if (record && from.record.restore)
                record.restore = from.record.restore;
        }
        // Maximized windows are re-maximized by Mutter itself.
    }

    // -- Tracking the pointer ------------------------------------------------

    _update() {
        const session = this._session;
        if (!session)
            return;
        const p = pointer();
        if (!session.armed) {
            const threshold = St.Settings.get().drag_threshold * scaleFactor();
            if (Math.hypot(p.x - session.startX, p.y - session.startY) < threshold)
                return;
            session.armed = true;
        }

        const monitor = monitorAt(p.x, p.y);
        const mon = monitorRect(monitor);
        if (!mon)
            return;

        let target = null;
        // The snap layouts bar takes precedence near the top centre.
        const barTarget = this._ext.settings.get_boolean('snap-layouts-on-drag')
            ? this._bar.update(p.x, p.y, monitor, session.win) : null;
        if (barTarget?.zone)
            target = {kind: 'layout', ...barTarget};
        else
            target = this._edgeTarget(p.x, p.y, monitor, mon, !barTarget?.blocksTop);

        session.target = target;
        if (!target) {
            this.preview.close([p.x, p.y]);
            return;
        }
        const wa = this._ext.snapper.workArea(target.monitor, session.win);
        const rect = G.zoneToRect(target.zone, wa, this._ext.snapper.gap);
        this.preview.open(session.win, insetRect(rect, wa, scaleFactor()), [p.x, p.y]);
    }

    _edgeTarget(x, y, monitor, mon, allowTop) {
        const s = scaleFactor();
        const near = this._ext.settings.get_boolean('snap-before-edge');
        const side = name => {
            if (near)
                return EDGE_NEAR * s;
            return sharedEdge(monitor, name, x, y) ? EDGE_SHARED * s : 0;
        };
        const short = Math.min(mon.width, mon.height);
        const corner = Math.min(Math.max(short * CORNER_FRACTION, CORNER_MIN * s), CORNER_MAX * s);

        // Different distances per side: hit-test each edge separately.
        const edges = {
            left: x <= mon.x + side('left'),
            right: x >= mon.x + mon.width - 1 - side('right'),
            top: y <= mon.y + side('top'),
            bottom: y >= mon.y + mon.height - 1 - side('bottom'),
        };
        const nearTop = y <= mon.y + corner, nearBottom = y >= mon.y + mon.height - 1 - corner;
        const nearLeft = x <= mon.x + corner, nearRight = x >= mon.x + mon.width - 1 - corner;

        let name = null;
        if ((edges.left && nearTop) || (edges.top && nearLeft))
            name = 'top-left';
        else if ((edges.right && nearTop) || (edges.top && nearRight))
            name = 'top-right';
        else if ((edges.left && nearBottom) || (edges.bottom && nearLeft))
            name = 'bottom-left';
        else if ((edges.right && nearBottom) || (edges.bottom && nearRight))
            name = 'bottom-right';
        else if (edges.left)
            name = 'left';
        else if (edges.right)
            name = 'right';
        else if (edges.top && allowTop)
            name = 'maximize';

        if (!name)
            return null;
        if (name === 'maximize' && !this._session.win.can_maximize())
            return null;
        return {kind: 'edge', name, zone: G.ZONES[name], monitor};
    }
}
