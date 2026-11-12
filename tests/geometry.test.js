// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Unit tests for extension/geometry.js (no GNOME Shell needed):
//   gjs -m tests/geometry.test.js

import * as G from '../extension/geometry.js';

let failures = 0, passes = 0;
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) {
        passes++;
    } else {
        failures++;
        print(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
    }
}
const round = zones => zones.map(z => Object.fromEntries(Object.entries(z).map(([k, v]) => [k, Math.round(v * 1000) / 1000])));

// -- zoneToRect ---------------------------------------------------------------
const wa = G.rect(0, 32, 1920, 1048);
check('left half', G.zoneToRect(G.ZONES.left, wa), G.rect(0, 32, 960, 1048));
check('right half', G.zoneToRect(G.ZONES.right, wa), G.rect(960, 32, 960, 1048));
check('bottom-right quarter', G.zoneToRect(G.ZONES['bottom-right'], wa), G.rect(960, 556, 960, 524));
check('thirds share edges', [0, 1, 2].map(i => G.zoneToRect({x: i / 3, y: 0, w: 1 / 3, h: 1}, wa)).map(r => [r.x, r.x + r.width]),
    [[0, 640], [640, 1280], [1280, 1920]]);
check('gap: outer full, inner half', G.zoneToRect(G.ZONES.left, wa, 8), G.rect(8, 40, 948, 1032));
check('gap: right half', G.zoneToRect(G.ZONES.right, wa, 8), G.rect(964, 40, 948, 1032));
check('rectToZone round trip', round([G.rectToZone(G.zoneToRect(G.ZONES['top-right'], wa), wa)]),
    [{x: 0.5, y: 0, w: 0.5, h: 0.5}]);
check('zoneName', G.zoneName({x: 0.5, y: 0.5, w: 0.5, h: 0.5}), 'bottom-right');
check('zoneName custom', G.zoneName({x: 0, y: 0, w: 2 / 3, h: 1}), null);

// -- edgeZoneAt -------------------------------------------------------------
const mon = G.rect(0, 0, 1920, 1080);
const opts = {edge: 0, corner: 130};
check('left edge', G.edgeZoneAt(0, 540, mon, opts), 'left');
check('right edge', G.edgeZoneAt(1919, 540, mon, opts), 'right');
check('top edge maximizes', G.edgeZoneAt(960, 0, mon, opts), 'maximize');
check('top edge off', G.edgeZoneAt(960, 0, mon, {...opts, top: false}), null);
check('bottom edge alone: nothing', G.edgeZoneAt(960, 1079, mon, opts), null);
check('top-left via left edge', G.edgeZoneAt(0, 100, mon, opts), 'top-left');
check('top-left via top edge', G.edgeZoneAt(100, 0, mon, opts), 'top-left');
check('bottom-right', G.edgeZoneAt(1919, 1000, mon, opts), 'bottom-right');
check('bottom-left via bottom edge', G.edgeZoneAt(50, 1079, mon, opts), 'bottom-left');
check('not at an edge', G.edgeZoneAt(5, 540, mon, opts), null);
check('near edge counts with a distance', G.edgeZoneAt(5, 540, mon, {...opts, edge: 32}), 'left');

// -- layouts ------------------------------------------------------------------
check('1080p: six layouts', G.layoutsFor(wa).map(l => l.id),
    ['halves', 'two-thirds-left', 'thirds', 'half-and-quarters', 'quarters', 'wide-center']);
check('laptop: four layouts', G.layoutsFor(G.rect(0, 0, 1366, 736)).map(l => l.id),
    ['halves', 'two-thirds-left', 'half-and-quarters', 'quarters']);
check('portrait', G.layoutsFor(G.rect(0, 0, 1080, 1888)).map(l => l.id),
    ['rows-halves', 'rows-two-thirds-top', 'rows-thirds', 'rows-half-and-quarters', 'quarters', 'rows-wide-center']);
for (const layout of [...G.layoutsFor(wa), ...G.layoutsFor(G.rect(0, 0, 1080, 1888))]) {
    const total = layout.zones.reduce((sum, z) => sum + z.w * z.h, 0);
    check(`${layout.id} covers the screen exactly`, Math.round(total * 1e6) / 1e6, 1);
}

// -- Snap Assist free space -----------------------------------------------------
const Z = G.ZONES;
check('after left half: right half', round(G.freeZonesAfter(Z.left, [])), [Z.right]);
check('after left half, top-right taken: bottom-right', round(G.freeZonesAfter(Z.left, [Z['top-right']])),
    [Z['bottom-right']]);
check('after left half, right taken: nothing', G.freeZonesAfter(Z.left, [Z.right]), []);
check('after a resized left (60%): the 40% beside it', round(G.freeZonesAfter({x: 0, y: 0, w: 0.6, h: 1}, [])),
    [{x: 0.6, y: 0, w: 0.4, h: 1}]);
check('after top-left alone: three quarters in turn', round(G.freeZonesAfter(Z['top-left'], [])),
    [Z['top-right'], Z['bottom-left'], Z['bottom-right']]);
check('after top-left with top-right taken: the bottom half', round(G.freeZonesAfter(Z['top-left'], [Z['top-right']])),
    [{x: 0, y: 0.5, w: 1, h: 0.5}]);
check('after top-left with right half taken: bottom-left', round(G.freeZonesAfter(Z['top-left'], [Z.right])),
    [Z['bottom-left']]);
check('after top half: bottom half', round(G.freeZonesAfter(Z.top, [])), [Z.bottom]);
check('coverage', G.coverage(Z.right, [Z['top-right']]), 0.5);
check('subtract', round(G.subtractZones({x: 0.5, y: 0, w: 0.5, h: 1}, [Z['top-right']])), [Z['bottom-right']]);

print(`${passes} passed, ${failures} failed`);
if (failures)
    imports.system.exit(1);
