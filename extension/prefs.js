// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Extensions that also take over window snapping or tiling.
const CONFLICTS = {
    'tiling-assistant@ubuntu.com': 'Ubuntu Tiling Assistant',
    'tiling-assistant@leleat-on-github': 'Tiling Assistant',
    'tilingshell@ferrarodomenico.com': 'Tiling Shell',
    'pop-shell@system76.com': 'Pop Shell',
    'forge@jmmaranan.com': 'Forge',
    'gTile@vibou': 'gTile',
    'wintile@nowsci.com': 'WinTile',
    'paperwm@paperwm.github.com': 'PaperWM',
    'material-shell@papyelgringo': 'Material Shell',
    'snaptile@muse83': 'SnapTile',
};

const SHORTCUTS = [
    [['Super', '←'], 'Snap to the left half · again to move to the monitor on the left'],
    [['Super', '→'], 'Snap to the right half · again to move to the monitor on the right'],
    [['Super', '↑'], 'Maximize · from a half, the top quarter of that side'],
    [['Super', '↓'], 'Restore · from a half, the bottom quarter · then minimize'],
    [['Super', 'Alt', '↑'], 'Snap to the top half'],
    [['Super', 'Alt', '↓'], 'Snap to the bottom half'],
    [['Super', 'Z'], 'Snap layouts for the focused window (then press the numbers)'],
];

/** A little picture of what the extension does, in the system accent colour. */
function illustration() {
    const style = Adw.StyleManager.get_default();
    const area = new Gtk.DrawingArea({
        content_width: 380,
        content_height: 190,
        halign: Gtk.Align.CENTER,
        margin_top: 6,
        margin_bottom: 12,
    });
    const round = (cr, x, y, w, h, r) => {
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    };
    area.set_draw_func((a, cr, width, height) => {
        const dark = style.dark;
        const accent = style.get_accent_color_rgba?.() ?? null;
        const [ar, ag, ab] = accent ? [accent.red, accent.green, accent.blue] : [0.21, 0.52, 0.89];
        const W = 360, H = 180;
        const ox = (width - W) / 2, oy = (height - H) / 2;
        // Screen
        round(cr, ox, oy, W, H, 12);
        cr.setSourceRGB(...(dark ? [0.16, 0.16, 0.18] : [0.88, 0.89, 0.92]));
        cr.fillPreserve();
        cr.setSourceRGBA(...(dark ? [1, 1, 1, 0.10] : [0, 0, 0, 0.10]));
        cr.setLineWidth(1);
        cr.stroke();
        const pad = 6, top = oy + pad, left = ox + pad, w = W - 2 * pad, h = H - 2 * pad;
        const win = (x, y, ww, hh, shadow) => {
            if (shadow) {
                round(cr, x + 1, y + 3, ww, hh, 6);
                cr.setSourceRGBA(0, 0, 0, dark ? 0.45 : 0.18);
                cr.fill();
            }
            round(cr, x, y, ww, hh, 6);
            cr.setSourceRGB(...(dark ? [0.24, 0.24, 0.27] : [0.99, 0.99, 1]));
            cr.fill();
            cr.rectangle(x, y + 12, ww, 0.8);
            cr.setSourceRGBA(...(dark ? [1, 1, 1, 0.08] : [0, 0, 0, 0.08]));
            cr.fill();
            for (let i = 0; i < 3; i++) {
                round(cr, x + 8, y + 22 + i * 12, ww * (0.7 - i * 0.15), 5, 2.5);
                cr.setSourceRGBA(...(dark ? [1, 1, 1, 0.13] : [0, 0, 0, 0.10]));
                cr.fill();
            }
        };
        // Everything on the screen is clipped to it.
        cr.save();
        round(cr, ox, oy, W, H, 12);
        cr.clip();
        // A window snapped to the left half.
        win(left, top, w / 2 - 2, h, false);
        // The frosted preview: top-right quarter.
        const px = left + w / 2 + 4, py = top + 4, pw = w / 2 - 8, ph = h / 2 - 6;
        round(cr, px, py, pw, ph, 7);
        cr.setSourceRGBA(ar, ag, ab, 0.28);
        cr.fillPreserve();
        cr.setSourceRGBA(ar, ag, ab, 0.9);
        cr.setLineWidth(1.2);
        cr.stroke();
        // The window being dragged into that corner.
        const dx = px + pw - 70, dy = py + 18;
        win(dx, dy, 96, 64, true);
        // Pointer on its title bar.
        const cx = dx + 60, cy = dy + 6;
        cr.moveTo(cx, cy);
        cr.lineTo(cx, cy + 15);
        cr.lineTo(cx + 4, cy + 11);
        cr.lineTo(cx + 7, cy + 17);
        cr.lineTo(cx + 9.5, cy + 16);
        cr.lineTo(cx + 6.5, cy + 10);
        cr.lineTo(cx + 11, cy + 10);
        cr.closePath();
        cr.setSourceRGB(1, 1, 1);
        cr.fillPreserve();
        cr.setSourceRGB(0.1, 0.1, 0.1);
        cr.setLineWidth(1);
        cr.stroke();
        cr.restore();
        // The snap bar peeking from the top.
        round(cr, ox + W / 2 - 44, oy - 3, 88, 9, 4.5);
        cr.setSourceRGBA(...(dark ? [0.32, 0.32, 0.36, 1] : [0.99, 0.99, 1, 1]));
        cr.fillPreserve();
        cr.setSourceRGBA(...(dark ? [1, 1, 1, 0.12] : [0, 0, 0, 0.14]));
        cr.setLineWidth(1);
        cr.stroke();
        cr.$dispose();
    });
    style.connect('notify::dark', () => area.queue_draw());
    style.connect('notify::accent-color-rgba', () => area.queue_draw());
    return area;
}

function keycaps(keys) {
    const box = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
    keys.forEach((key, i) => {
        if (i > 0)
            box.append(new Gtk.Label({label: '+', css_classes: ['dim-label']}));
        box.append(new Gtk.Label({label: key, css_classes: ['keycap']}));
    });
    return box;
}

export default class WindowSnappingPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(660, 820);
        window.set_search_enabled?.(true);

        const page = new Adw.PreferencesPage({
            title: 'Window Snapping',
            icon_name: 'view-grid-symbolic',
        });
        window.add(page);

        const hero = new Adw.PreferencesGroup();
        hero.add(illustration());
        page.add(hero);

        this._addConflicts(page);

        // ---- Snapping (mirrors Windows 11's Settings › Multitasking › Snap windows)
        const snap = new Adw.PreferencesGroup({
            title: 'Snap windows',
            description: 'Drag a window to a side of the screen for half of it, to a corner for a quarter, ' +
                'or to the top to maximize. GNOME’s own edge tiling is switched off while this is on.',
        });
        page.add(snap);
        const bindSwitch = (group, key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
            return row;
        };
        bindSwitch(snap, 'snap-on-drag', 'Snap by dragging',
            'Drag a window by its title bar to an edge or corner of the screen');
        const near = bindSwitch(snap, 'snap-before-edge',
            'When I drag a window, let me snap it without dragging all the way to the screen edge',
            'Also makes snapping easy on an edge shared with another monitor');
        const bar = bindSwitch(snap, 'snap-layouts-on-drag',
            'Show snap layouts when I drag a window to the top of my screen',
            'Drop the window on a layout’s zone to snap it there');
        bindSwitch(snap, 'snap-assist', 'When I snap a window, suggest what I can snap next to it',
            'Snap Assist shows your other windows in the space that’s left');
        bindSwitch(snap, 'snap-fill', 'When I snap a window, size it to fill the available space',
            'If the window next to it was resized, the new one takes exactly what’s left');
        bindSwitch(snap, 'joint-resize', 'When I resize a snapped window, resize the windows next to it too',
            'Drag the line between snapped windows to resize them together');
        for (const row of [near, bar])
            settings.bind('snap-on-drag', row, 'sensitive', Gio.SettingsBindFlags.GET);

        // ---- Keyboard
        const keys = new Adw.PreferencesGroup({title: 'Keyboard'});
        page.add(keys);
        bindSwitch(keys, 'keyboard-snapping', 'Windows-style Super + arrow keys',
            'Halves, quarters, maximize, restore, minimize and moving between monitors, exactly like Win + arrow keys');

        const shortcutRow = (key, title, subtitle, accel) => {
            const row = new Adw.SwitchRow({title, subtitle});
            row.active = settings.get_strv(key).length > 0;
            row.connect('notify::active', () => {
                settings.set_strv(key, row.active ? [accel] : []);
            });
            settings.connect(`changed::${key}`, () => {
                const on = settings.get_strv(key).length > 0;
                if (row.active !== on)
                    row.active = on;
            });
            keys.add(row);
            return row;
        };
        shortcutRow('show-snap-layouts', 'Super + Z opens snap layouts',
            'Press a layout’s number, then a zone’s number, like Win + Z', '<Super>z');
        const halves = new Adw.SwitchRow({
            title: 'Super + Alt + ↑ / ↓ snap to the top / bottom half',
            subtitle: 'GNOME normally uses these to step through the overview and app grid; Super alone still opens the overview',
        });
        halves.active = settings.get_strv('snap-top-half').length > 0;
        halves.connect('notify::active', () => {
            settings.set_strv('snap-top-half', halves.active ? ['<Super><Alt>Up'] : []);
            settings.set_strv('snap-bottom-half', halves.active ? ['<Super><Alt>Down'] : []);
        });
        keys.add(halves);

        const cheat = new Adw.ExpanderRow({
            title: 'All shortcuts',
            subtitle: 'Hold Super and press the arrows several times: Snap Assist opens when you let go',
        });
        for (const [combo, text] of SHORTCUTS) {
            const row = new Adw.ActionRow({title: text});
            row.add_suffix(keycaps(combo));
            cheat.add_row(row);
        }
        keys.add(cheat);

        // ---- Look
        const look = new Adw.PreferencesGroup({title: 'Look'});
        page.add(look);
        const gap = new Adw.SpinRow({
            title: 'Gap between snapped windows',
            subtitle: 'In pixels. Windows 11 leaves none, so snapped windows touch and get square corners',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 48, step_increment: 2, page_increment: 8}),
        });
        settings.bind('window-gap', gap, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(gap);

        const modes = ['system', 'always', 'never'];
        const anim = new Adw.ComboRow({
            title: 'Animations',
            model: Gtk.StringList.new(['Follow system setting', 'Always', 'Never']),
        });
        const syncAnim = () => {
            anim.selected = Math.max(0, modes.indexOf(settings.get_string('animations')));
            const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const sysOn = iface.get_boolean('enable-animations');
            anim.subtitle = sysOn
                ? 'Snapping animates like the rest of GNOME'
                : 'GNOME’s animations are off, so snapping is instant unless you choose Always';
        };
        syncAnim();
        anim.connect('notify::selected', () => {
            settings.set_string('animations', modes[anim.selected] ?? 'system');
        });
        settings.connect('changed::animations', syncAnim);
        look.add(anim);

        // ---- Troubleshooting
        const debug = new Adw.PreferencesGroup({
            title: 'Troubleshooting',
            description: 'With debug logging on, follow along with: journalctl --user -f -g window-snapping',
        });
        page.add(debug);
        bindSwitch(debug, 'debug', 'Debug logging', 'Log every snap, drag and key press');

        // ---- About
        const about = new Adw.PreferencesGroup();
        page.add(about);
        const repo = this.metadata.url ?? 'https://github.com/Jire/window-snapping';
        const link = (title, subtitle, uri, icon) => {
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: icon}));
            row.connect('activated', () => {
                if (Gtk.UriLauncher)
                    new Gtk.UriLauncher({uri}).launch(window, null, null);
                else
                    Gtk.show_uri(window, uri, 0);
            });
            about.add(row);
        };
        link('Report a problem or suggest a feature', `${repo}/issues`, `${repo}/issues`, 'adw-external-link-symbolic');
        link('Source code', repo, repo, 'adw-external-link-symbolic');
    }

    /** Warn when another snapping/tiling extension is enabled at the same time. */
    _addConflicts(page) {
        const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const enabled = shell.get_strv('enabled-extensions');
        const found = Object.keys(CONFLICTS).filter(uuid => enabled.includes(uuid));
        if (!found.length)
            return;
        const group = new Adw.PreferencesGroup({
            title: 'Another tiling extension is on',
            description: 'It also handles dragging windows to the screen edges and the Super + arrow keys, ' +
                'so the two fight over every snap. Turn it off to use Window Snapping.',
        });
        page.add(group);
        for (const uuid of found) {
            const row = new Adw.ActionRow({title: CONFLICTS[uuid], subtitle: uuid});
            row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic', css_classes: ['warning']}));
            const button = new Gtk.Button({
                label: 'Turn Off',
                valign: Gtk.Align.CENTER,
                css_classes: ['destructive-action'],
            });
            button.connect('clicked', () => {
                Gio.DBus.session.call(
                    'org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
                    'org.gnome.Shell.Extensions', 'DisableExtension',
                    new GLib.Variant('(s)', [uuid]), null, Gio.DBusCallFlags.NONE, -1, null,
                    (conn, res) => {
                        try {
                            conn.call_finish(res);
                            row.subtitle = 'Turned off';
                            button.sensitive = false;
                        } catch (e) {
                            row.subtitle = `Couldn’t turn it off: ${e.message}`;
                        }
                    });
            });
            row.add_suffix(button);
            group.add(row);
        }
    }
}
