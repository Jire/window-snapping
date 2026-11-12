// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Pure geometry: zones, layouts and hit-testing. No Shell imports, so this
// module is shared with prefs.js and can be unit-tested with plain `gjs -m`.
//
// A zone is a rectangle in fractions of a monitor's work area:
//   {x: 0, y: 0, w: 0.5, h: 1}  is the left half.

export const ZONES = Object.freeze({
    'left': {x: 0, y: 0, w: 1 / 2, h: 1},
    'right': {x: 1 / 2, y: 0, w: 1 / 2, h: 1},
    'top': {x: 0, y: 0, w: 1, h: 1 / 2},
    'bottom': {x: 0, y: 1 / 2, w: 1, h: 1 / 2},
    'top-left': {x: 0, y: 0, w: 1 / 2, h: 1 / 2},
    'top-right': {x: 1 / 2, y: 0, w: 1 / 2, h: 1 / 2},
    'bottom-left': {x: 0, y: 1 / 2, w: 1 / 2, h: 1 / 2},
    'bottom-right': {x: 1 / 2, y: 1 / 2, w: 1 / 2, h: 1 / 2},
    'maximize': {x: 0, y: 0, w: 1, h: 1},
});

// Zone edges closer than this (about 2 px on a 1920 px screen) are the same.
const EPS = 1e-3;

export function rect(x, y, width, height) {
    return {x, y, width, height};
}

export function rectFromMtk(r) {
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}

export function rectsEqual(a, b, tolerance = 0) {
    return !!a && !!b &&
        Math.abs(a.x - b.x) <= tolerance &&
        Math.abs(a.y - b.y) <= tolerance &&
        Math.abs(a.width - b.width) <= tolerance &&
        Math.abs(a.height - b.height) <= tolerance;
}

export function containsPoint(r, x, y) {
    return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

export function intersects(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height;
}

export function intersection(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    return x2 > x1 && y2 > y1 ? rect(x1, y1, x2 - x1, y2 - y1) : null;
}

export function area(r) {
    return r ? r.width * r.height : 0;
}

export function center(r) {
    return [r.x + r.width / 2, r.y + r.height / 2];
}

export function zonesEqual(a, b) {
    return !!a && !!b &&
        Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 &&
        Math.abs(a.w - b.w) < 1e-3 && Math.abs(a.h - b.h) < 1e-3;
}

/** The named zone ('left', 'top-right', …) matching `zone`, or null. */
export function zoneName(zone) {
    for (const [name, z] of Object.entries(ZONES)) {
        if (zonesEqual(z, zone))
            return name;
    }
    return null;
}

/**
 * Pixel rectangle for a zone inside a work area. `gap` leaves that much space
 * at the work area's edges and between neighbouring zones (half on each side).
 * Edges are rounded so that adjacent zones always share an exact boundary.
 */
export function zoneToRect(zone, workArea, gap = 0) {
    const edge = (frac, origin, size) => origin + Math.round(frac * size);
    let x1 = edge(zone.x, workArea.x, workArea.width);
    let x2 = edge(zone.x + zone.w, workArea.x, workArea.width);
    let y1 = edge(zone.y, workArea.y, workArea.height);
    let y2 = edge(zone.y + zone.h, workArea.y, workArea.height);
    if (gap > 0) {
        const half = Math.floor(gap / 2);
        x1 += zone.x <= EPS ? gap : gap - half;
        y1 += zone.y <= EPS ? gap : gap - half;
        x2 -= zone.x + zone.w >= 1 - EPS ? gap : half;
        y2 -= zone.y + zone.h >= 1 - EPS ? gap : half;
    }
    return rect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
}

/** Inverse of zoneToRect (ignoring gaps): fractions of the work area. */
export function rectToZone(r, workArea) {
    return {
        x: (r.x - workArea.x) / workArea.width,
        y: (r.y - workArea.y) / workArea.height,
        w: r.width / workArea.width,
        h: r.height / workArea.height,
    };
}

/** Which named zones are adjacent to / complete each other. */
export const COMPLEMENT = Object.freeze({
    'left': ['right'],
    'right': ['left'],
    'top': ['bottom'],
    'bottom': ['top'],
    'top-left': ['top-right', 'bottom-left', 'bottom-right'],
    'top-right': ['top-left', 'bottom-right', 'bottom-left'],
    'bottom-left': ['bottom-right', 'top-left', 'top-right'],
    'bottom-right': ['bottom-left', 'top-right', 'top-left'],
});

/**
 * Hit-test the pointer against a monitor's snap edges and corners.
 *
 * Mirrors Windows: the left/right edges snap to halves, the corners to
 * quarters and the top edge maximizes. The bottom edge only matters for its
 * two corners. `edge` is how close (px) the pointer must be to an edge;
 * `corner` is how far along an edge, from a corner, counts as that corner.
 *
 * Returns a ZONES name or null.
 */
export function edgeZoneAt(px, py, monitor, {edge, corner, top = true}) {
    const left = px <= monitor.x + edge;
    const right = px >= monitor.x + monitor.width - 1 - edge;
    const atTop = py <= monitor.y + edge;
    const bottom = py >= monitor.y + monitor.height - 1 - edge;
    const nearTop = py <= monitor.y + corner;
    const nearBottom = py >= monitor.y + monitor.height - 1 - corner;
    const nearLeft = px <= monitor.x + corner;
    const nearRight = px >= monitor.x + monitor.width - 1 - corner;

    if ((left && nearTop) || (atTop && nearLeft))
        return 'top-left';
    if ((right && nearTop) || (atTop && nearRight))
        return 'top-right';
    if ((left && nearBottom) || (bottom && nearLeft))
        return 'bottom-left';
    if ((right && nearBottom) || (bottom && nearRight))
        return 'bottom-right';
    if (left)
        return 'left';
    if (right)
        return 'right';
    if (atTop && top)
        return 'maximize';
    return null;
}

// -- Snap Assist: what's free after a snap ---------------------------------

// A zone counts as taken when snapped windows cover this much of it.
export const TAKEN = 0.6;

/** How much of `zone` (0–1) the zones in `others` cover. */
export function coverage(zone, others) {
    let covered = 0;
    for (const o of others) {
        const r = intersection(
            {x: zone.x, y: zone.y, width: zone.w, height: zone.h},
            {x: o.x, y: o.y, width: o.w, height: o.h});
        covered += area(r);
    }
    return Math.min(1, covered / (zone.w * zone.h));
}

/** `area` minus the zones in `holes`, as a list of zones (slivers dropped). */
export function subtractZones(area_, holes) {
    let pieces = [area_];
    for (const h of holes) {
        const next = [];
        for (const p of pieces) {
            const ix1 = Math.max(p.x, h.x), iy1 = Math.max(p.y, h.y);
            const ix2 = Math.min(p.x + p.w, h.x + h.w), iy2 = Math.min(p.y + p.h, h.y + h.h);
            if (ix2 - ix1 <= EPS || iy2 - iy1 <= EPS) {
                next.push(p);
                continue;
            }
            if (iy1 > p.y + EPS)
                next.push({x: p.x, y: p.y, w: p.w, h: iy1 - p.y});
            if (iy2 < p.y + p.h - EPS)
                next.push({x: p.x, y: iy2, w: p.w, h: p.y + p.h - iy2});
            if (ix1 > p.x + EPS)
                next.push({x: p.x, y: iy1, w: ix1 - p.x, h: iy2 - iy1});
            if (ix2 < p.x + p.w - EPS)
                next.push({x: ix2, y: iy1, w: p.x + p.w - ix2, h: iy2 - iy1});
        }
        pieces = next;
    }
    return pieces.filter(p => p.w >= 0.15 && p.h >= 0.15);
}

/**
 * The free space next to a window just snapped into `zone`, as the queue of
 * zones Snap Assist offers, given the zones of the other snapped windows:
 *
 *  - full height (halves, columns): the space beside it, minus what's taken
 *  - full width (top/bottom halves): the space above or below it
 *  - a corner: the other three cells one at a time (sideways neighbour,
 *    then the one above/below, then the diagonal), or as one piece when the
 *    free cells form a rectangle (e.g. the whole bottom half)
 */
export function freeZonesAfter(z, others) {
    const all = [z, ...others];
    const atL = z.x <= EPS, atR = z.x + z.w >= 1 - EPS;
    const atT = z.y <= EPS, atB = z.y + z.h >= 1 - EPS;
    const largest = pieces => pieces.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 1);

    if (atT && atB && !(atL && atR)) {
        const space = atL ? {x: z.x + z.w, y: 0, w: 1 - z.x - z.w, h: 1} : {x: 0, y: 0, w: z.x, h: 1};
        return largest(subtractZones(space, others));
    }
    if (atL && atR && !(atT && atB)) {
        const space = atT ? {x: 0, y: z.y + z.h, w: 1, h: 1 - z.y - z.h} : {x: 0, y: 0, w: 1, h: z.y};
        return largest(subtractZones(space, others));
    }
    if ((atL || atR) && (atT || atB)) {
        const sx = atL ? z.x + z.w : z.x, sy = atT ? z.y + z.h : z.y;
        const cells = {
            tl: {x: 0, y: 0, w: sx, h: sy}, tr: {x: sx, y: 0, w: 1 - sx, h: sy},
            bl: {x: 0, y: sy, w: sx, h: 1 - sy}, br: {x: sx, y: sy, w: 1 - sx, h: 1 - sy},
        };
        const horizontal = (atT ? 't' : 'b') + (atL ? 'r' : 'l');
        const vertical = (atT ? 'b' : 't') + (atL ? 'l' : 'r');
        const diagonal = (atT ? 'b' : 't') + (atL ? 'r' : 'l');
        const free = [horizontal, vertical, diagonal].filter(k => coverage(cells[k], all) < TAKEN);
        if (free.length === 2) {
            const [a, b] = free.map(k => cells[k]);
            const union = {
                x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
                h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y),
            };
            if (Math.abs(union.w * union.h - (a.w * a.h + b.w * b.h)) < EPS)
                return [union];
        }
        return free.map(k => cells[k]);
    }
    return [];
}

/** True when the monitor is taller than it is wide. */
export function isPortrait(r) {
    return r.height > r.width;
}

// -- Snap layouts ----------------------------------------------------------
//
// The templates Windows 11 offers in its Snap Layouts flyout and snap bar.
// Screens at least 1850 effective pixels wide get six, smaller ones four
// (three-column layouts need the room); portrait screens get stacked ones.

const L = (id, zones) => Object.freeze({id, zones: zones.map(z => Object.freeze(z))});

const HALVES = L('halves', [{x: 0, y: 0, w: 1 / 2, h: 1}, {x: 1 / 2, y: 0, w: 1 / 2, h: 1}]);
const TWO_THIRDS = L('two-thirds-left', [{x: 0, y: 0, w: 2 / 3, h: 1}, {x: 2 / 3, y: 0, w: 1 / 3, h: 1}]);
const THIRDS = L('thirds', [{x: 0, y: 0, w: 1 / 3, h: 1}, {x: 1 / 3, y: 0, w: 1 / 3, h: 1}, {x: 2 / 3, y: 0, w: 1 / 3, h: 1}]);
const HALF_QUARTERS = L('half-and-quarters', [
    {x: 0, y: 0, w: 1 / 2, h: 1},
    {x: 1 / 2, y: 0, w: 1 / 2, h: 1 / 2},
    {x: 1 / 2, y: 1 / 2, w: 1 / 2, h: 1 / 2},
]);
const QUARTERS = L('quarters', [
    {x: 0, y: 0, w: 1 / 2, h: 1 / 2},
    {x: 1 / 2, y: 0, w: 1 / 2, h: 1 / 2},
    {x: 0, y: 1 / 2, w: 1 / 2, h: 1 / 2},
    {x: 1 / 2, y: 1 / 2, w: 1 / 2, h: 1 / 2},
]);
const WIDE_CENTER = L('wide-center', [{x: 0, y: 0, w: 1 / 4, h: 1}, {x: 1 / 4, y: 0, w: 1 / 2, h: 1}, {x: 3 / 4, y: 0, w: 1 / 4, h: 1}]);

const ROWS_HALVES = L('rows-halves', [{x: 0, y: 0, w: 1, h: 1 / 2}, {x: 0, y: 1 / 2, w: 1, h: 1 / 2}]);
const ROWS_TWO_THIRDS = L('rows-two-thirds-top', [{x: 0, y: 0, w: 1, h: 2 / 3}, {x: 0, y: 2 / 3, w: 1, h: 1 / 3}]);
const ROWS_THIRDS = L('rows-thirds', [{x: 0, y: 0, w: 1, h: 1 / 3}, {x: 0, y: 1 / 3, w: 1, h: 1 / 3}, {x: 0, y: 2 / 3, w: 1, h: 1 / 3}]);
const ROWS_HALF_QUARTERS = L('rows-half-and-quarters', [
    {x: 0, y: 0, w: 1, h: 1 / 2},
    {x: 0, y: 1 / 2, w: 1 / 2, h: 1 / 2},
    {x: 1 / 2, y: 1 / 2, w: 1 / 2, h: 1 / 2},
]);
const ROWS_WIDE_CENTER = L('rows-wide-center', [{x: 0, y: 0, w: 1, h: 1 / 4}, {x: 0, y: 1 / 4, w: 1, h: 1 / 2}, {x: 0, y: 3 / 4, w: 1, h: 1 / 4}]);

export const LARGE_SCREEN = 1850;

/** Layout templates for a work area (logical pixels). */
export function layoutsFor(workArea) {
    if (isPortrait(workArea)) {
        return workArea.height >= LARGE_SCREEN
            ? [ROWS_HALVES, ROWS_TWO_THIRDS, ROWS_THIRDS, ROWS_HALF_QUARTERS, QUARTERS, ROWS_WIDE_CENTER]
            : [ROWS_HALVES, ROWS_TWO_THIRDS, ROWS_THIRDS, ROWS_HALF_QUARTERS];
    }
    return workArea.width >= LARGE_SCREEN
        ? [HALVES, TWO_THIRDS, THIRDS, HALF_QUARTERS, QUARTERS, WIDE_CENTER]
        : [HALVES, TWO_THIRDS, HALF_QUARTERS, QUARTERS];
}
