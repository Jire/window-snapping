// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Snap Assist: after a window is snapped, the space that's left fills with
// thumbnails of your other windows; pick one and it snaps into that space.
//
//  - half snap: the other half (or what's left of it)
//  - quarter snap: the remaining quarters one at a time, or the free area as
//    one piece when it's a rectangle (e.g. the bottom half)
//  - snap layout: each remaining zone of the layout in turn
//
// Click a thumbnail, or use the arrow keys/Tab and Enter. Esc or a click
// anywhere else closes it, leaving everything where it is.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Acrylic} from './acrylic.js';
import {accentRgb, styleVariant, vbox} from './compat.js';
import * as G from './geometry.js';
import {typeName} from './gtype.js';
import {insetRect} from './preview.js';
import {isSnappable} from './snapper.js';

const FADE_MS = 160;
const NEXT_ZONE_DELAY_MS = 140;
const CARD_GAP = 16;
const PANEL_PADDING = 24;
const HEADER_HEIGHT = 34;
const MAX_CARD_WIDTH = 360;
const MIN_CARD_WIDTH = 120;

function scale() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

// -- Thumbnails ---------------------------------------------------------------

const WindowCard = GObject.registerClass({
    GTypeName: typeName('WindowCard'),
    Signals: {'chosen': {}, 'close-requested': {}},
}, class WindowCard extends St.Button {
    _init(win, width, thumbHeight) {
        const s = scale();
        super._init({
            style_class: 'wsnap-card',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
        });
        this.win = win;
        this.set_size(width, Math.round(HEADER_HEIGHT * s + thumbHeight));

        const box = vbox({x_expand: true, y_expand: true});
        this.set_child(box);

        const header = new St.BoxLayout({style_class: 'wsnap-card-header', x_expand: true});
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        const icon = app?.create_icon_texture(18 * s) ??
            new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 18});
        icon.add_style_class_name?.('wsnap-card-icon');
        header.add_child(icon);
        const title = new St.Label({
            style_class: 'wsnap-card-title',
            text: win.get_title() || app?.get_name() || '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(title);
        this._close = new St.Button({
            style_class: 'wsnap-card-close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
            opacity: 0,
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: false,
        });
        this._close.connect('clicked', () => this.emit('close-requested'));
        header.add_child(this._close);
        box.add_child(header);

        // Live thumbnail: a clone of the window, without its shadows.
        const thumbArea = new St.Widget({
            style_class: 'wsnap-card-thumb-area',
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        box.add_child(thumbArea);
        const actor = win.get_compositor_private();
        if (actor) {
            const frame = win.get_frame_rect(), buffer = win.get_buffer_rect();
            const k = Math.min((width - 16 * s) / frame.width, (thumbHeight - 12 * s) / frame.height, 1);
            const holder = new St.Widget({
                clip_to_allocation: true,
                width: Math.round(frame.width * k),
                height: Math.round(frame.height * k),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const clone = new Clutter.Clone({source: actor});
            clone.set_size(Math.round(buffer.width * k), Math.round(buffer.height * k));
            clone.set_position(Math.round((buffer.x - frame.x) * k), Math.round((buffer.y - frame.y) * k));
            holder.add_child(clone);
            thumbArea.add_child(holder);
        }

        this.accent = null;
        this.connect('clicked', () => this.emit('chosen'));
        this.connect('notify::hover', () => this._sync());
        this.connect('key-focus-in', () => this._sync());
        this.connect('key-focus-out', () => this._sync());
    }

    /** Hover/focus: show the close button, outline the card in the accent colour. */
    _sync() {
        const active = this.hover || this.has_key_focus();
        this._close.ease({
            opacity: active ? 255 : 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.set_style(active && this.accent ? `border-color: ${this.accent};` : null);
    }

    setAccent(accent) {
        this.accent = accent;
        this._sync();
    }
});

// -- The panel ----------------------------------------------------------------

class AssistPanel {
    constructor(assist, session, zone, candidates) {
        this._assist = assist;
        this._ext = assist._ext;
        this._session = session;
        this.zone = zone;
        this._cards = [];
        this._closed = false;

        const monitor = session.monitor;
        const snapper = this._ext.snapper;
        const wa = snapper.workArea(monitor);
        const zoneRect = G.zoneToRect(zone, wa, snapper.gap);
        const rect = insetRect(zoneRect, wa, scale());

        // Catches clicks anywhere else on screen, which close Snap Assist.
        this._overlay = new St.Widget({
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._overlay.connect('button-release-event', () => {
            this._assist.dismiss();
            return Clutter.EVENT_STOP;
        });
        this._overlay.connect('touch-event', (a, event) => {
            if (event.type() === Clutter.EventType.TOUCH_END)
                this._assist.dismiss();
            return Clutter.EVENT_STOP;
        });
        this._overlay.connect('key-press-event', (a, event) => this._onKey(event));
        Main.layoutManager.uiGroup.add_child(this._overlay);

        // Like Windows, the free space shows the desktop (frosted), not the
        // windows behind it: they're the thumbnails now. The wallpaper covers
        // the whole zone, gutters included, so nothing peeks through.
        this._addWallpaper(monitor, zoneRect);

        // Its glass frosts just the wallpaper, too.
        this._panel = new Acrylic({
            radius: 16,
            styleClass: 'wsnap-assist',
            sources: () => [this._wallpaperGroup],
        });
        this._panel.set_position(rect.x, rect.y);
        this._panel.set_size(rect.width, rect.height);
        this._panel.reactive = true; // clicks between cards don't close it
        this._overlay.add_child(this._panel);
        this._applyStyle();

        this._cardLayer = new St.Widget({x: rect.x, y: rect.y, width: rect.width, height: rect.height});
        this._overlay.add_child(this._cardLayer);
        this._layoutCards(candidates, rect.width, rect.height);

        this._grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.POPUP});
        // GNOME ≤ 50 report whether the keyboard grab succeeded; 51 dropped it.
        const seatState = this._grab.get_seat_state?.();
        if (seatState !== undefined && !(seatState & Clutter.GrabState.KEYBOARD)) {
            Main.popModal(this._grab);
            this._grab = null;
            this.destroy();
            return;
        }
        this._cards[0]?.grab_key_focus();

        // Appear: panel fades in, cards rise into place one after another.
        const motion = this._ext.motion;
        for (const layer of [this._wallpaper, this._panel].filter(Boolean)) {
            layer.opacity = 0;
            motion.ease(layer, {opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._cards.forEach((card, i) => {
            card.opacity = 0;
            card.translation_y = 12 * scale();
            motion.ease(card, {
                opacity: 255,
                translation_y: 0,
                delay: 30 + i * 22,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        });
    }

    get open() {
        return !this._closed;
    }

    _addWallpaper(monitor, rect) {
        const mon = Main.layoutManager.monitors[monitor];
        if (!mon)
            return;
        // The wallpaper actor always covers the whole monitor, so it sits in a
        // container clipped to the zone, offset to line up with the desktop.
        this._wallpaper = new St.Widget({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            clip_to_allocation: true,
        });
        const group = new Meta.BackgroundGroup({
            x: mon.x - rect.x,
            y: mon.y - rect.y,
            width: mon.width,
            height: mon.height,
            layout_manager: new Clutter.BinLayout(),
        });
        this._wallpaper.add_child(group);
        this._wallpaperGroup = group;
        this._overlay.add_child(this._wallpaper);
        this._bgManager = new Background.BackgroundManager({
            container: group,
            monitorIndex: monitor,
            controlPosition: false,
            useContentSize: false,
        });
    }

    _applyStyle() {
        const light = styleVariant(Main) === 'light';
        this._overlay[light ? 'add_style_class_name' : 'remove_style_class_name']('wsnap-light');
        this._panel.setTint(light
            ? 'background-color: rgba(250, 250, 251, 0.62);'
            : 'background-color: rgba(30, 30, 34, 0.55);');
        const [r, g, b] = accentRgb();
        this._accent = `rgb(${r}, ${g}, ${b})`;
        for (const card of this._cards ?? [])
            card.setAccent(this._accent);
    }

    updateColors() {
        this._applyStyle();
    }

    /** Lay the cards out in centred rows, as large as fits. */
    _layoutCards(windows, width, height) {
        const s = scale();
        const pad = PANEL_PADDING * s, gap = CARD_GAP * s, header = HEADER_HEIGHT * s;
        const availW = width - 2 * pad, availH = height - 2 * pad;
        const n = windows.length;
        const ratio = 0.66; // thumbnail height / width

        let best = null;
        for (let cols = 1; cols <= n; cols++) {
            const rows = Math.ceil(n / cols);
            let w = Math.min((availW - (cols - 1) * gap) / cols, MAX_CARD_WIDTH * s);
            const hFor = cw => rows * (header + cw * ratio) + (rows - 1) * gap;
            if (hFor(w) > availH)
                w = Math.max(((availH - (rows - 1) * gap) / rows - header) / ratio, 0);
            // Biggest cards win; with equal sizes (capped), fewer rows.
            if (!best || w > best.w + 0.5 || (Math.abs(w - best.w) <= 0.5 && rows < best.rows))
                best = {cols, rows, w};
        }
        const w = Math.max(Math.round(best.w), MIN_CARD_WIDTH * s);
        const thumbH = Math.round(w * ratio);
        const cardH = header + thumbH;
        const totalH = best.rows * cardH + (best.rows - 1) * gap;
        let y = Math.round((height - totalH) / 2);

        for (let row = 0; row < best.rows; row++) {
            const inRow = windows.slice(row * best.cols, (row + 1) * best.cols);
            const rowW = inRow.length * w + (inRow.length - 1) * gap;
            let x = Math.round((width - rowW) / 2);
            for (const win of inRow) {
                const card = new WindowCard(win, w, thumbH);
                card.set_position(x, y);
                card.row = row;
                card.col = Math.round((x - (width - rowW) / 2) / (w + gap));
                card.setAccent(this._accent);
                card.connect('chosen', () => this._assist.choose(this, win));
                card.connect('close-requested', () => win.delete(global.get_current_time()));
                this._cardLayer.add_child(card);
                this._cards.push(card);
                x += w + gap;
            }
            y += cardH + gap;
        }
    }

    _onKey(event) {
        // Super+Arrow keeps working while Snap Assist is open, as on Windows.
        if (this._ext.keyboard?.forward(event))
            return Clutter.EVENT_STOP;
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this._assist.dismiss();
            return Clutter.EVENT_STOP;
        }
        const focused = this._cards.find(c => c.has_key_focus()) ?? this._cards[0];
        if (!focused)
            return Clutter.EVENT_PROPAGATE;
        let next = null;
        const sameRow = this._cards.filter(c => c.row === focused.row);
        switch (key) {
        case Clutter.KEY_Left:
            next = sameRow.find(c => c.col === focused.col - 1) ?? sameRow[sameRow.length - 1];
            break;
        case Clutter.KEY_Right:
            next = sameRow.find(c => c.col === focused.col + 1) ?? sameRow[0];
            break;
        case Clutter.KEY_Up:
        case Clutter.KEY_Down: {
            const rows = [...new Set(this._cards.map(c => c.row))];
            const r = rows[(rows.indexOf(focused.row) + (key === Clutter.KEY_Up ? -1 : 1) + rows.length) % rows.length];
            const inRow = this._cards.filter(c => c.row === r);
            next = inRow.reduce((a, b) => Math.abs(b.col - focused.col) < Math.abs(a.col - focused.col) ? b : a);
            break;
        }
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            const back = key === Clutter.KEY_ISO_Left_Tab || (event.get_state() & Clutter.ModifierType.SHIFT_MASK);
            const i = this._cards.indexOf(focused);
            next = this._cards[(i + (back ? -1 : 1) + this._cards.length) % this._cards.length];
            break;
        }
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_space:
            this._assist.choose(this, focused.win);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
            focused.win.delete(global.get_current_time());
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        next?.grab_key_focus();
        return Clutter.EVENT_STOP;
    }

    removeWindow(win) {
        const card = this._cards.find(c => c.win === win);
        if (!card)
            return;
        this._cards = this._cards.filter(c => c !== card);
        card.destroy();
        if (!this._cards.length)
            this._assist.dismiss();
        else if (!this._cards.some(c => c.has_key_focus()))
            this._cards[0].grab_key_focus();
    }

    /** Fade out and remove. */
    close(animate = true) {
        if (this._closed)
            return;
        this._closed = true;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._overlay.reactive = false;
        if (!animate) {
            this.destroy();
            return;
        }
        this._ext.motion.ease(this._overlay, {
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    destroy() {
        this._closed = true;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._bgManager?.destroy();
        this._bgManager = null;
        this._overlay?.destroy();
        this._overlay = null;
    }
}

// -- Sessions -----------------------------------------------------------------

export class SnapAssist {
    constructor(ext) {
        this._ext = ext;
        this._session = null;
        this._panel = null;
        this._nextId = 0;

        global.workspace_manager.connectObject('active-workspace-changed', () => this.dismiss(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this.dismiss(), this);
    }

    destroy() {
        this.dismiss();
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
    }

    updateColors() {
        this._panel?.updateColors();
    }

    get enabled() {
        return this._ext.settings.get_boolean('snap-assist');
    }

    /** After a window was snapped to an edge/corner/half (drag or keyboard). */
    afterSnap(record) {
        if (!this.enabled || !record)
            return;
        const queue = this._zonesAfter(record);
        this._start(record, queue);
    }

    /** After a window was snapped into one zone of a snap layout. */
    afterLayoutSnap(record, layout, zoneIndex) {
        if (!this.enabled || !record)
            return;
        const queue = layout.zones.filter((z, i) => i !== zoneIndex);
        this._start(record, queue, layout);
    }

    dismiss() {
        if (this._nextId) {
            GLib.source_remove(this._nextId);
            this._nextId = 0;
        }
        this._panel?.close();
        this._panel = null;
        if (this._session) {
            for (const win of this._session.watched)
                win.disconnectObject(this);
        }
        this._session = null;
    }

    get active() {
        return !!this._session;
    }

    // ------------------------------------------------------------------------

    _start(record, queue, layout = null) {
        this.dismiss();
        const workspace = record.win.get_workspace() ?? global.workspace_manager.get_active_workspace();
        this._session = {
            monitor: record.monitor,
            workspace,
            queue: [...queue],
            used: new Set([record.win]),
            records: [record],
            layout,
            watched: new Set(),
        };
        this._watch(record.win);
        this._showNext();
    }

    _watch(win) {
        if (this._session.watched.has(win))
            return;
        this._session.watched.add(win);
        win.connectObject('unmanaged', () => {
            this._session?.watched.delete(win);
            if (this._session?.used.has(win))
                this.dismiss();
            else
                this._panel?.removeWindow(win);
        }, this);
    }

    /** Free space next to a snapped window, as a queue of zones to offer. */
    _zonesAfter(record) {
        const others = this._ext.snapper.snappedOn(record.monitor, record.win.get_workspace(), {exclude: record.win})
            .map(r => r.zone);
        return G.freeZonesAfter(record.zone, others);
    }

    _candidates() {
        const s = this._session;
        const snappedHere = new Set(this._ext.snapper.snappedOn(s.monitor, s.workspace).map(r => r.win));
        return global.display.get_tab_list(Meta.TabList.NORMAL, s.workspace).filter(win =>
            !s.used.has(win) &&
            !snappedHere.has(win) &&
            !win.is_skip_taskbar() &&
            win.get_window_type() === Meta.WindowType.NORMAL &&
            isSnappable(win) &&
            !!win.get_compositor_private());
    }

    _showNext() {
        const s = this._session;
        if (!s)
            return;
        const others = this._ext.snapper.snappedOn(s.monitor, s.workspace).map(r => r.zone);
        let zone = null;
        while (s.queue.length) {
            const z = s.queue.shift();
            if (G.coverage(z, others) < G.TAKEN) {
                zone = z;
                break;
            }
        }
        const candidates = zone ? this._candidates() : [];
        if (!zone || !candidates.length) {
            this.dismiss();
            return;
        }
        for (const win of candidates)
            this._watch(win);
        this._panel = new AssistPanel(this, s, zone, candidates);
        if (!this._panel.open) {
            this._panel = null;
            this.dismiss();
        }
    }

    /** A thumbnail was picked: snap that window into the zone, then continue. */
    choose(panel, win) {
        const s = this._session;
        if (!s || panel !== this._panel)
            return;
        const zone = panel.zone;
        this._panel.close();
        this._panel = null;

        const record = this._ext.snapper.snap(win, zone, s.monitor, {
            fill: false,
            layoutId: s.layout?.id ?? null,
            animate: !win.minimized,
        });
        win.activate(global.get_current_time());
        if (record) {
            s.used.add(win);
            s.records.push(record);
            this._ext.snapper.joinGroup(s.records);
        }

        if (!s.queue.length) {
            this.dismiss();
            return;
        }
        // Let the window land before offering the next space.
        this._nextId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NEXT_ZONE_DELAY_MS, () => {
            this._nextId = 0;
            this._showNext();
            return GLib.SOURCE_REMOVE;
        });
    }
}
