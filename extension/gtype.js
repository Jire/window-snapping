// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// GObject type names for the classes this extension registers.
//
// GJS refuses to register the same type name twice in one GNOME Shell
// session. Reloading without logging out (scripts/hot-load.js) loads a fresh
// copy of these modules from a new folder, so every copy gets names of its
// own, derived from where it was loaded from.

import GLib from 'gi://GLib';

const SUFFIX = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, import.meta.url, -1).slice(0, 10);

/** A GTypeName that is unique to this copy of the extension. */
export function typeName(name) {
    return `WindowSnapping_${name}_${SUFFIX}`;
}
