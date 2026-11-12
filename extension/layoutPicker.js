// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// A row (or grid) of snap layout thumbnails, each made of clickable zones.
// Shared by the snap bar that drops down while dragging and the Super+Z
// flyout. During a drag Mutter owns the pointer, so the snap bar hit-tests
// zones itself (zoneAt); the flyout uses ordinary hover/click events.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {accentRgb} from './compat.js';

// Space between zones inside a thumbnail, and their corner radius (px at
// scale 1); thumbnails are drawn with the work area's aspect ratio.
const CELL_GAP = 3;
const THUMB_HEIGHT = 58;

const ZoneCell = GObject.registerClass({
    Signals: {
        'activated': {},
        'hovered': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class ZoneCell extends St.Button {
    _init(layoutIndex, zoneIndex, reactive) {
        super._init({
            style_class: 'wsnap-zone',
            reactive,
            can_focus: false,
            track_hover: reactive,
            x_expand: false,
            y_expand: false,
        });
        this.layoutIndex = layoutIndex;
        this.zoneIndex = zoneIndex;
        this._label = new St.Label({
            style_class: 'wsnap-zone-number',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.set_child(this._label);
        if (reactive) {
            this.connect('clicked', () => this.emit('activated'));
            this.connect('notify::hover', () => this.emit('hovered', this.hover));
        }
    }

    setNumber(n) {
        this._label.text = n ? String(n) : '';
        this._label.visible = !!n;
    }

    setHighlighted(on, accentStyle) {
        if (on) {
            this.add_style_pseudo_class('checked');
            this.set_style(accentStyle);
        } else {
            this.remove_style_pseudo_class('checked');
            this.set_style(null);
        }
    }
});

const LayoutThumb = GObject.registerClass({
}, class LayoutThumb extends St.Widget {
    _init(layout, index, width, height, reactive) {
        super._init({
            style_class: 'wsnap-layout',
            width,
            height,
            reactive: false,
        });
        this.layout = layout;
        this.index = index;
        this._w = width;
        this._h = height;
        this.cells = layout.zones.map((zone, i) => {
            const cell = new ZoneCell(index, i, reactive);
            this.add_child(cell);
            return cell;
        });
        this._badge = new St.Label({style_class: 'wsnap-layout-number', visible: false});
        this.add_child(this._badge);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const gap = CELL_GAP * s;
        const w = box.get_width(), h = box.get_height();
        this.layout.zones.forEach((z, i) => {
            const x1 = Math.round(z.x * w + (z.x > 0.001 ? gap / 2 : 0));
            const y1 = Math.round(z.y * h + (z.y > 0.001 ? gap / 2 : 0));
            const x2 = Math.round((z.x + z.w) * w - (z.x + z.w < 0.999 ? gap / 2 : 0));
            const y2 = Math.round((z.y + z.h) * h - (z.y + z.h < 0.999 ? gap / 2 : 0));
            const cellBox = new Clutter.ActorBox();
            cellBox.set_origin(x1, y1);
            cellBox.set_size(Math.max(1, x2 - x1), Math.max(1, y2 - y1));
            this.cells[i].allocate(cellBox);
        });
        const [, , bw, bh] = this._badge.get_preferred_size();
        const badgeBox = new Clutter.ActorBox();
        badgeBox.set_origin(Math.round((w - bw) / 2), Math.round((h - bh) / 2));
        badgeBox.set_size(bw, bh);
        this._badge.allocate(badgeBox);
    }

    vfunc_get_preferred_width(_forHeight) {
        return [this._w, this._w];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [this._h, this._h];
    }

    setBadge(n) {
        this._badge.text = n ? String(n) : '';
        this._badge.visible = !!n;
    }
});

export const LayoutPicker = GObject.registerClass({
    Signals: {
        'zone-activated': {param_types: [GObject.TYPE_INT, GObject.TYPE_INT]},
        'zone-hovered': {param_types: [GObject.TYPE_INT, GObject.TYPE_INT]},
    },
}, class LayoutPicker extends St.Widget {
    /**
     * layouts: from geometry.layoutsFor(); aspect: work area width/height;
     * columns: thumbnails per row; reactive: hover/click with the pointer.
     */
    _init({layouts, aspect, columns = layouts.length, reactive = false}) {
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const grid = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_spacing: 14 * s,
            row_spacing: 14 * s,
        });
        super._init({style_class: 'wsnap-layouts', layout_manager: grid});
        this.layouts = layouts;
        const h = Math.round(THUMB_HEIGHT * s);
        const w = Math.round(h * Math.min(Math.max(aspect, 0.5), 2.4));
        this.thumbs = layouts.map((layout, i) => {
            const thumb = new LayoutThumb(layout, i, w, h, reactive);
            grid.attach(thumb, i % columns, Math.floor(i / columns), 1, 1);
            for (const cell of thumb.cells) {
                cell.connect('activated', () => this.emit('zone-activated', cell.layoutIndex, cell.zoneIndex));
                cell.connect('hovered', (c, on) => {
                    if (on)
                        this.setHover(cell.layoutIndex, cell.zoneIndex);
                    else if (this._hover?.[0] === cell.layoutIndex && this._hover?.[1] === cell.zoneIndex)
                        this.setHover(-1, -1);
                });
            }
            return thumb;
        });
        this._hover = null;
        this.updateColors();
    }

    updateColors() {
        const [r, g, b] = accentRgb();
        this._accentStyle = `background-color: rgb(${r}, ${g}, ${b}); border-color: rgba(255, 255, 255, 0.35);`;
        if (this._hover)
            this.setHover(...this._hover);
    }

    /** Highlight one zone (-1, -1 for none). Emits zone-hovered on change. */
    setHover(layoutIndex, zoneIndex) {
        const prev = this._hover;
        if (prev && prev[0] === layoutIndex && prev[1] === zoneIndex)
            return;
        if (prev)
            this.thumbs[prev[0]]?.cells[prev[1]]?.setHighlighted(false);
        this._hover = layoutIndex >= 0 ? [layoutIndex, zoneIndex] : null;
        if (this._hover)
            this.thumbs[layoutIndex]?.cells[zoneIndex]?.setHighlighted(true, this._accentStyle);
        this.emit('zone-hovered', layoutIndex, zoneIndex);
    }

    get hover() {
        return this._hover;
    }

    /** Zone under a stage point, as [layoutIndex, zoneIndex], or null. */
    zoneAt(x, y) {
        for (const thumb of this.thumbs) {
            for (const cell of thumb.cells) {
                const [cx, cy] = cell.get_transformed_position();
                const [cw, ch] = cell.get_transformed_size();
                if (x >= cx && x < cx + cw && y >= cy && y < cy + ch)
                    return [cell.layoutIndex, cell.zoneIndex];
            }
        }
        return null;
    }

    /** Number badges: 'layouts' (1…n on each layout), 'zones' (inside one layout) or 'none'. */
    setNumbering(mode, activeLayout = -1) {
        this.thumbs.forEach((thumb, i) => {
            thumb.setBadge(mode === 'layouts' ? i + 1 : 0);
            thumb.cells.forEach((cell, j) => cell.setNumber(mode === 'zones' && i === activeLayout ? j + 1 : 0));
            thumb.opacity = mode === 'zones' && i !== activeLayout ? 110 : 255;
        });
    }
});
