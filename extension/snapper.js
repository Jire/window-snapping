// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The snapping engine: puts windows into zones, remembers which windows are
// snapped where (and the floating geometry to restore them to), keeps them
// in their zones when the work area changes, and notices when something
// else moves them out.
//
// Everything that changes a window's geometry for snapping goes through here.
//
// Square corners: like Windows 11 (and GNOME's own tiling), snapped windows
// should look tiled. Mutter only tells apps a window is tiled when it's
// maximized in a direction, so full-height zones (halves, thirds) use
// vertical maximization and full-width ones (top/bottom halves) horizontal
// maximization. Quarters can't have that, so they keep the app's corners.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Compat from './compat.js';
import * as G from './geometry.js';

// Geometry differences up to this many pixels still count as "in the zone"
// (apps with size increments, such as terminals, rarely land exactly).
const TOLERANCE = 3;
// How long to wait for an app to accept a new size before trusting whatever
// it reports.
const SETTLE_MS = 1500;
// Smallest fraction of the work area a "snap fill" may shrink a zone to.
const MIN_FILL_FRACTION = 0.15;
const EPS = 1e-3;

function frameOf(win) {
    return G.rectFromMtk(win.get_frame_rect());
}

/** Windows this extension is willing to snap. */
export function isSnappable(win) {
    if (!win || win.is_override_redirect?.())
        return false;
    const type = win.get_window_type();
    if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG)
        return false;
    if (win.is_attached_dialog?.() || win.is_fullscreen())
        return false;
    if (!win.allows_move())
        return false;
    // Mutter says maximized windows can't be resized; what matters is
    // whether they can be once restored.
    if (Compat.maximizeFlags(win) === Meta.MaximizeFlags.BOTH)
        return win.resizeable ?? win.can_maximize();
    return win.allows_resize();
}

export class SnapRecord {
    constructor(win) {
        this.win = win;
        this.zone = null; // {x, y, w, h} fractions of the work area
        this.monitor = -1; // logical monitor index
        this.rect = null; // where the window should be
        this.restore = null; // floating rect to go back to when unsnapped
        this.group = null; // Set of records snapped together
        this.layoutId = null;
        this.pendingUntil = 0; // waiting for the app to apply our geometry
    }

    get name() {
        return G.zoneName(this.zone);
    }

    get pending() {
        return GLib.get_monotonic_time() < this.pendingUntil;
    }
}

export class Snapper {
    constructor(ext) {
        this._ext = ext;
        this._records = new Map();
        this._floating = new Map();
        // Snapped windows that got maximized: restoring them goes back to
        // their pre-snap geometry, like Windows.
        this._maximizedFromSnap = new Map();
        this._watched = new Set();
        this._busy = 0;
        this._reflowId = 0;

        global.display.connectObject(
            'window-created', (d, win) => this._watch(win),
            'workareas-changed', () => this._queueReflow(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queueReflow(), this);

        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
    }

    destroy() {
        if (this._reflowId) {
            GLib.source_remove(this._reflowId);
            this._reflowId = 0;
        }
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const win of this._watched) {
            win.disconnectObject(this);
            win.get_compositor_private()?.disconnectObject(this);
        }
        this._watched.clear();
        this._records.clear();
        this._floating.clear();
        this._maximizedFromSnap.clear();
    }

    get gap() {
        return this._ext.settings.get_int('window-gap');
    }

    // -- Queries -----------------------------------------------------------

    recordFor(win) {
        return this._records.get(win) ?? null;
    }

    isSnapped(win) {
        return this._records.has(win);
    }

    /** Snapped windows on a monitor + workspace (minimized ones excluded). */
    snappedOn(monitor, workspace, {exclude = null} = {}) {
        const out = [];
        for (const record of this._records.values()) {
            const win = record.win;
            if (win === exclude || win.minimized || record.monitor !== monitor)
                continue;
            if (workspace && !win.located_on_workspace(workspace))
                continue;
            out.push(record);
        }
        return out;
    }

    /** Work area of a monitor on the window's (or the active) workspace. */
    workArea(monitor, win = null) {
        const ws = win?.get_workspace?.() ?? global.workspace_manager.get_active_workspace();
        const r = ws ? ws.get_work_area_for_monitor(monitor) : Main.layoutManager.getWorkAreaForMonitor(monitor);
        return G.rectFromMtk(r);
    }

    /** The geometry to restore a window to when it leaves its zone. */
    restoreRectFor(win) {
        const record = this._records.get(win);
        if (record?.restore)
            return {...record.restore};
        if (!record && Compat.maximizeFlags(win) === 0)
            return frameOf(win);
        const remembered = this._floating.get(win);
        if (remembered)
            return {...remembered};
        // Never seen floating (it was maximized before we started): use a
        // comfortable size, centred on its monitor.
        const wa = this.workArea(win.get_monitor(), win);
        const width = Math.round(wa.width * 0.6), height = Math.round(wa.height * 0.7);
        return G.rect(wa.x + Math.round((wa.width - width) / 2), wa.y + Math.round((wa.height - height) / 2), width, height);
    }

    // -- Snapping ----------------------------------------------------------

    /**
     * Snap a window into a zone of a monitor.
     * opts: {animate, fill, layoutId, restore (floating rect to remember)}
     */
    snap(win, zone, monitor, opts = {}) {
        const {animate = true, fill = this._ext.settings.get_boolean('snap-fill'), layoutId = null} = opts;
        if (!isSnappable(win))
            return null;

        if (G.zonesEqual(zone, G.ZONES.maximize)) {
            this.maximize(win, monitor, {animate, restore: opts.restore});
            return null;
        }

        const restore = opts.restore ?? this.restoreRectFor(win);
        if (fill)
            zone = this._fillZone(zone, monitor, win.get_workspace(), win);

        let record = this._records.get(win);
        if (!record) {
            record = new SnapRecord(win);
            this._records.set(win, record);
        }
        this._maximizedFromSnap.delete(win);
        this._leaveGroup(record);
        record.zone = zone;
        record.monitor = monitor;
        record.restore = restore;
        record.layoutId = layoutId;

        const rect = G.zoneToRect(zone, this.workArea(monitor, win), this.gap);
        this._place(win, record, rect, {animate});
        this._ext.log(`snap "${win.get_title()}" → ${G.zoneName(zone) ?? JSON.stringify(zone)} on monitor ${monitor}`);
        return record;
    }

    /** Maximize (the top edge / Super+Up), remembering the floating geometry. */
    maximize(win, monitor = win.get_monitor(), {animate = true, restore = null} = {}) {
        if (!win.can_maximize())
            return;
        const floating = restore ?? this.restoreRectFor(win);
        this._forget(win);
        this._floating.set(win, floating);
        const run = () => {
            this._busy++;
            try {
                if (win.minimized)
                    win.unminimize();
                if (Compat.maximizeFlags(win) !== 0)
                    this._unmaximize(win);
                if (monitor !== win.get_monitor())
                    win.move_to_monitor(monitor);
                // Give the window its floating geometry first: that's what
                // un-maximizing it later goes back to.
                const r = this._onMonitor(floating, monitor, win);
                win.move_resize_frame(false, r.x, r.y, r.width, r.height);
                this._skipEffect(win);
                Compat.maximize(win);
                this._clearSkip(win);
            } finally {
                this._busy--;
            }
        };
        if (animate)
            this._ext.morphs.run(win, run);
        else
            run();
    }

    /**
     * Take a window out of its zone and give it back its floating geometry.
     * With `rect` the caller decides where it goes (dragging uses this).
     */
    unsnap(win, {rect = null, animate = true} = {}) {
        const target = rect ?? this.restoreRectFor(win);
        const flags = Compat.maximizeFlags(win);
        this._forget(win);
        this._maximizedFromSnap.delete(win);
        if (flags === 0 && G.rectsEqual(frameOf(win), target, 0))
            return;
        const run = () => {
            this._busy++;
            try {
                if (flags !== 0)
                    this._unmaximize(win);
                win.move_resize_frame(false, target.x, target.y, target.width, target.height);
            } finally {
                this._busy--;
            }
        };
        if (animate)
            this._ext.morphs.run(win, run);
        else
            run();
    }

    /** Forget that a window is snapped, without moving it. */
    release(win) {
        this._forget(win);
    }

    _skipEffect(win) {
        // GNOME animates (un)maximizing; we animate snapping ourselves.
        const actor = win.get_compositor_private();
        if (actor)
            Main.wm.skipNextEffect(actor);
    }

    /** Never leave an unused "skip" behind: it would eat a later animation. */
    _clearSkip(win) {
        const actor = win.get_compositor_private();
        if (actor)
            Main.wm._skippedActors?.delete?.(actor);
    }

    _unmaximize(win, flags = Meta.MaximizeFlags.BOTH) {
        this._skipEffect(win);
        Compat.unmaximize(win, flags);
        this._clearSkip(win);
    }

    /**
     * Switch maximize directions to exactly `wanted`, touching only the ones
     * that change (Mutter recomputes the other direction otherwise).
     */
    _setFlags(win, wanted) {
        const current = Compat.maximizeFlags(win);
        const remove = current & ~wanted;
        const add = wanted & ~current;
        if (remove)
            this._unmaximize(win, remove);
        if (add) {
            this._skipEffect(win);
            Compat.maximizeFlagsSet(win, add);
            this._clearSkip(win);
        }
    }

    /** Maximize directions that make a zone look tiled (see top of file). */
    _tiledFlags(win, zone) {
        if (this.gap > 0 || !win.can_maximize())
            return 0;
        const fullHeight = zone.y <= EPS && zone.y + zone.h >= 1 - EPS;
        const fullWidth = zone.x <= EPS && zone.x + zone.w >= 1 - EPS;
        if (fullHeight && !fullWidth)
            return Meta.MaximizeFlags.VERTICAL;
        if (fullWidth && !fullHeight)
            return Meta.MaximizeFlags.HORIZONTAL;
        return 0;
    }

    _place(win, record, rect, {animate}) {
        record.rect = rect;
        record.pendingUntil = GLib.get_monotonic_time() + SETTLE_MS * 1000;
        const wanted = this._tiledFlags(win, record.zone);
        const run = () => {
            this._busy++;
            try {
                if (win.minimized)
                    win.unminimize();
                if (win.get_monitor() !== record.monitor)
                    win.move_to_monitor(record.monitor);
                // Maximize state first, geometry last: the last request wins.
                this._setFlags(win, wanted);
                win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
            } finally {
                this._busy--;
            }
        };
        if (animate && !Main.overview.visible)
            this._ext.morphs.run(win, run, wanted ? null : rect);
        else
            run();
    }

    /** Re-apply a record's zone (after the work area changed, etc.). */
    reapply(record, {animate = false} = {}) {
        const rect = G.zoneToRect(record.zone, this.workArea(record.monitor, record.win), this.gap);
        if (G.rectsEqual(frameOf(record.win), rect, 0) &&
            Compat.maximizeFlags(record.win) === this._tiledFlags(record.win, record.zone)) {
            record.rect = rect;
            return;
        }
        this._place(record.win, record, rect, {animate});
    }

    /**
     * Set a snapped window's rect directly (joint resizing), keeping it
     * snapped. The zone is recomputed from the rect.
     */
    resizeSnapped(record, rect) {
        const wa = this.workArea(record.monitor, record.win);
        record.zone = G.rectToZone(this._ungap(rect, wa), wa);
        record.rect = rect;
        record.pendingUntil = GLib.get_monotonic_time() + SETTLE_MS * 1000;
        this._busy++;
        try {
            record.win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        } finally {
            this._busy--;
        }
    }

    /** Accept a window's current geometry as its snapped geometry. */
    adopt(record) {
        const wa = this.workArea(record.monitor, record.win);
        record.rect = frameOf(record.win);
        record.zone = G.rectToZone(this._ungap(record.rect, wa), wa);
        record.pendingUntil = 0;
    }

    /**
     * Let a snapped window be resized along an edge Mutter would otherwise
     * lock (a vertically maximized half can't change height), keeping its
     * current geometry.
     */
    unlockForResize(win, vertical) {
        const flags = Compat.maximizeFlags(win);
        const lock = vertical ? Meta.MaximizeFlags.VERTICAL : Meta.MaximizeFlags.HORIZONTAL;
        if (!(flags & lock))
            return;
        const r = frameOf(win);
        this._busy++;
        try {
            this._unmaximize(win, lock);
            win.move_resize_frame(false, r.x, r.y, r.width, r.height);
        } finally {
            this._busy--;
        }
    }

    // -- Groups --------------------------------------------------------------

    /** Windows snapped together (via Snap Assist or a layout) form a group. */
    joinGroup(records) {
        const group = new Set();
        for (const r of records) {
            this._leaveGroup(r);
            r.group = group;
            group.add(r);
        }
        return group;
    }

    _leaveGroup(record) {
        if (!record.group)
            return;
        record.group.delete(record);
        if (record.group.size === 1)
            [...record.group][0].group = null;
        record.group = null;
    }

    // -- Snap fill -----------------------------------------------------------

    /**
     * "When I snap a window, automatically size it to fill available space":
     * if neighbouring snapped windows were resized, grow or shrink the new
     * zone's inner edges to meet theirs instead of overlapping or leaving a
     * hole.
     */
    _fillZone(zone, monitor, workspace, win) {
        const z = {...zone};
        const others = this.snappedOn(monitor, workspace, {exclude: win}).map(r => r.zone);
        const overlapsV = o => o.y < z.y + z.h - EPS && z.y < o.y + o.h - EPS;
        const overlapsH = o => o.x < z.x + z.w - EPS && z.x < o.x + o.w - EPS;
        const nearest = (candidates, original) => candidates.length
            ? candidates.reduce((a, b) => Math.abs(a - original) <= Math.abs(b - original) ? a : b)
            : null;

        let left = z.x, right = z.x + z.w, top = z.y, bottom = z.y + z.h;
        if (z.x > EPS) {
            const c = nearest(others.filter(o => o.x < z.x && overlapsV(o) && Math.abs(o.x + o.w - z.x) < 0.3)
                .map(o => o.x + o.w), z.x);
            if (c !== null)
                left = c;
        }
        if (z.x + z.w < 1 - EPS) {
            const c = nearest(others.filter(o => o.x + o.w > z.x + z.w && overlapsV(o) && Math.abs(o.x - (z.x + z.w)) < 0.3)
                .map(o => o.x), z.x + z.w);
            if (c !== null)
                right = c;
        }
        if (z.y > EPS) {
            const c = nearest(others.filter(o => o.y < z.y && overlapsH(o) && Math.abs(o.y + o.h - z.y) < 0.3)
                .map(o => o.y + o.h), z.y);
            if (c !== null)
                top = c;
        }
        if (z.y + z.h < 1 - EPS) {
            const c = nearest(others.filter(o => o.y + o.h > z.y + z.h && overlapsH(o) && Math.abs(o.y - (z.y + z.h)) < 0.3)
                .map(o => o.y), z.y + z.h);
            if (c !== null)
                bottom = c;
        }
        if (right - left < MIN_FILL_FRACTION || bottom - top < MIN_FILL_FRACTION)
            return zone;
        return {x: left, y: top, w: right - left, h: bottom - top};
    }

    /** Undo the gap insets of a rect, so zones stay gap-independent. */
    _ungap(r, wa) {
        const gap = this.gap;
        if (gap <= 0)
            return r;
        const half = Math.floor(gap / 2);
        const atL = r.x - wa.x <= gap + 1, atT = r.y - wa.y <= gap + 1;
        const atR = wa.x + wa.width - (r.x + r.width) <= gap + 1;
        const atB = wa.y + wa.height - (r.y + r.height) <= gap + 1;
        const x1 = r.x - (atL ? gap : gap - half), y1 = r.y - (atT ? gap : gap - half);
        const x2 = r.x + r.width + (atR ? gap : half), y2 = r.y + r.height + (atB ? gap : half);
        return G.rect(x1, y1, x2 - x1, y2 - y1);
    }

    /** Move a rect (from any monitor) onto `monitor`, keeping its relative position. */
    _onMonitor(rect, monitor, win) {
        const wa = this.workArea(monitor, win);
        const from = global.display.get_monitor_index_for_rect(new Mtk.Rectangle({
            x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height),
        }));
        const r = {...rect};
        if (from >= 0 && from !== monitor) {
            const src = this.workArea(from, win);
            r.x = wa.x + Math.round((rect.x - src.x) * wa.width / src.width);
            r.y = wa.y + Math.round((rect.y - src.y) * wa.height / src.height);
        }
        r.width = Math.min(r.width, wa.width);
        r.height = Math.min(r.height, wa.height);
        r.x = Math.min(Math.max(r.x, wa.x), wa.x + wa.width - r.width);
        r.y = Math.min(Math.max(r.y, wa.y), wa.y + wa.height - r.height);
        return r;
    }

    // -- Bookkeeping ---------------------------------------------------------

    _watch(win) {
        if (!win || this._watched.has(win) || win.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        this._watched.add(win);
        win.connectObject(
            'size-changed', () => this._onGeometryChanged(win),
            'position-changed', () => this._onGeometryChanged(win),
            'notify::maximized-horizontally', () => this._onMaximizeChanged(win),
            'notify::maximized-vertically', () => this._onMaximizeChanged(win),
            'notify::fullscreen', () => this._onFullscreen(win),
            'unmanaged', () => this._onUnmanaged(win),
            this);
        const actor = win.get_compositor_private();
        if (actor?.get_texture?.())
            this._remember(win);
        else
            actor?.connectObject('first-frame', () => this._remember(win), this);
    }

    /** Remember a floating window's geometry: it's what it goes back to. */
    _remember(win) {
        if (this._records.has(win) || Compat.maximizeFlags(win) !== 0 || win.is_fullscreen() || win.minimized)
            return;
        const r = frameOf(win);
        if (r.width > 0 && r.height > 0)
            this._floating.set(win, r);
    }

    _onMaximizeChanged(win) {
        if (this._busy)
            return;
        const flags = Compat.maximizeFlags(win);
        const record = this._records.get(win);
        if (record && flags === Meta.MaximizeFlags.BOTH) {
            // Maximized from its zone (double-click, maximize button…):
            // restoring it later goes back to the pre-snap geometry.
            this._maximizedFromSnap.set(win, record.restore);
            this._forget(win);
            return;
        }
        if (flags === 0 && this._maximizedFromSnap.has(win)) {
            const restore = this._maximizedFromSnap.get(win);
            this._maximizedFromSnap.delete(win);
            if (!restore)
                return;
            // Still before the app has applied Mutter's restored size, so this
            // replaces it rather than adding a second jump.
            const r = this._onMonitor(restore, win.get_monitor(), win);
            this._busy++;
            try {
                win.move_resize_frame(false, r.x, r.y, r.width, r.height);
            } finally {
                this._busy--;
            }
        }
    }

    _onGeometryChanged(win) {
        const record = this._records.get(win);
        if (!record) {
            if (!this._busy && !this._ext.isGrabbing(win))
                this._remember(win);
            return;
        }
        if (this._busy || this._ext.isGrabbing(win))
            return;
        if (Compat.maximizeFlags(win) === Meta.MaximizeFlags.BOTH)
            return;
        const current = frameOf(win);
        if (G.rectsEqual(current, record.rect, TOLERANCE))
            return;
        if (record.pending)
            return; // the app is still settling into the zone
        // Moved to another monitor as a whole (Super+Shift+Arrow, a monitor
        // change): it's still in the same zone, just elsewhere.
        const monitor = win.get_monitor();
        if (monitor !== record.monitor) {
            const there = G.zoneToRect(record.zone, this.workArea(monitor, win), this.gap);
            if (G.rectsEqual(current, there, TOLERANCE * 4)) {
                record.monitor = monitor;
                record.rect = current;
                return;
            }
        }
        // Something else moved or resized the window: it's no longer snapped.
        this._ext.log(`"${win.get_title()}" left its zone`);
        this._forget(win);
        this._remember(win);
    }

    _onFullscreen(win) {
        if (win.is_fullscreen())
            return;
        const record = this._records.get(win);
        if (record)
            this.reapply(record);
    }

    _onUnmanaged(win) {
        win.disconnectObject(this);
        win.get_compositor_private()?.disconnectObject(this);
        this._watched.delete(win);
        this._forget(win);
        this._floating.delete(win);
        this._maximizedFromSnap.delete(win);
    }

    _forget(win) {
        const record = this._records.get(win);
        if (!record)
            return;
        this._leaveGroup(record);
        this._records.delete(win);
        if (record.restore)
            this._floating.set(win, record.restore);
    }

    _queueReflow() {
        if (this._reflowId)
            return;
        // Let Mutter finish moving windows around first.
        this._reflowId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._reflowId = 0;
            this._reflow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reflow() {
        const nMonitors = global.display.get_n_monitors();
        for (const record of [...this._records.values()]) {
            const win = record.win;
            if (record.monitor >= nMonitors) {
                this._forget(win);
                continue;
            }
            if (win.minimized || win.is_fullscreen() || Compat.maximizeFlags(win) === Meta.MaximizeFlags.BOTH)
                continue;
            this.reapply(record);
        }
    }
}
