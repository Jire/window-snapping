// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Acrylic: the frosted glass behind every overlay (snap preview, snap bar,
// layouts flyout, Snap Assist, resize placeholders).
//
// GNOME's "background" blur copies whatever is already on screen and blurs
// that copy. But GNOME only repaints the parts of the screen that change, so
// the copy is partly stale, which shows up as hard-edged bars of sharp and
// blurred content. Acrylic never reads the screen. It rebuilds what's behind
// it from live clones of the actors painted before it (wallpaper, windows,
// panels) and blurs those in its own offscreen buffer, which is rendered
// whole, and only when something behind it changes.
//
// One shader pass then finishes the backdrop: it cuts the blur to an
// antialiased rounded rectangle, draws the drop shadow around it (only
// around it: a shadow under translucent glass would darken its edges
// unevenly) and dithers, so smooth gradients can't band. The tint and the
// border are drawn on top by St, from the CSS class given.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {typeName} from './gtype.js';

// Positions are in the backdrop's coordinates (stage pixels):
//   wsnap_map:    position = map.xy + texture coordinate × map.zw
//   wsnap_shape:  width, height, corner radius, device pixels per pixel
//   wsnap_shadow: x offset, y offset, blur sigma × √2, spread
//   wsnap_shadow_color: straight RGBA
const DECLARATIONS = `
uniform vec4 wsnap_map;
uniform vec4 wsnap_shape;
uniform vec4 wsnap_shadow;
uniform vec4 wsnap_shadow_color;

float wsnap_box(vec2 p, vec2 size, float radius) {
    vec2 h = size * 0.5;
    vec2 q = abs(p - h) - h + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float wsnap_erf(float x) {
    float s = sign(x);
    float a = abs(x);
    float t = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
    t *= t;
    return s - s / (t * t);
}

// Interleaved gradient noise: made for dithering, and well-behaved at
// large coordinates (unlike the usual sin() hash).
float wsnap_noise(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

// Coverage from the signed distance to the rounded rectangle (one device
// pixel of antialiasing), a Gaussian shadow outside it, ±1 LSB of noise.
// Colours are premultiplied, as Cogl blends them. (GNOME 46–50 try to set a
// different blend mode on Shell.GLSLEffect, but Cogl rejects it.)
const CODE = `
vec2 wsnap_p = wsnap_map.xy + cogl_tex_coord_in[0].xy * wsnap_map.zw;
float wsnap_in = clamp(0.5 - wsnap_box(wsnap_p, wsnap_shape.xy, wsnap_shape.z) * wsnap_shape.w, 0.0, 1.0);
float wsnap_sd = wsnap_box(wsnap_p - wsnap_shadow.xy + wsnap_shadow.w,
    wsnap_shape.xy + 2.0 * wsnap_shadow.w, wsnap_shape.z + wsnap_shadow.w);
float wsnap_sa = wsnap_shadow_color.a * cogl_color_in.a * (0.5 - 0.5 * wsnap_erf(wsnap_sd / wsnap_shadow.z));
vec4 wsnap_c = cogl_color_out * wsnap_in + vec4(wsnap_shadow_color.rgb, 1.0) * (wsnap_sa * (1.0 - wsnap_in));
wsnap_c.rgb += (wsnap_noise(gl_FragCoord.xy) - 0.5) * (2.0 / 255.0) * wsnap_c.a;
cogl_color_out = wsnap_c;
`;

/** The shader effect. GNOME 46–50 have Shell.GLSLEffect; 51 replaced it with snippets on Clutter.ShaderEffect. */
function defineGlassShader() {
    if (Shell.GLSLEffect) {
        return GObject.registerClass({GTypeName: typeName('GlassShader')},
        class GlassShader extends Shell.GLSLEffect {
            vfunc_build_pipeline() {
                // GNOME 46–47 take Shell's copy of the enum here, 48–50 Cogl's.
                const hook = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;
                this.add_glsl_snippet(hook, DECLARATIONS, CODE, false);
            }

            setUniform(name, values) {
                this.set_uniform_float(this.get_uniform_location(name), values.length, values);
                this.queue_repaint();
            }
        });
    }
    return GObject.registerClass({GTypeName: typeName('GlassShader')},
    class GlassShader extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
        }

        setUniform(name, values) {
            this.set_uniform_float(name, values.length, values);
            this.queue_repaint();
        }
    });
}

const GlassShader = defineGlassShader();

/**
 * Where an offscreen effect's texture lies, for an actor painting the box
 * (x1, y1)–(x2, y2): Clutter grows the box to whole pixels plus padding
 * (_clutter_actor_box_enlarge_for_effects(), unchanged from GNOME 46 to 51).
 * Returns [x, y, width, height] in the actor's coordinates.
 */
function offscreenBox(x1, y1, x2, y2) {
    const width = Math.round(x2 - x1) + 3, height = Math.round(y2 - y1) + 3;
    return [Math.ceil(x2 + 0.75) - width, Math.ceil(y2 + 0.75) - height, width, height];
}

function box(x, y, width, height) {
    const b = new Clutter.ActorBox();
    b.set_origin(x, y);
    b.set_size(width, height);
    return b;
}

/**
 * A window group has no size of its own (its windows sit all over the
 * stage), and on GNOME 46–50 a clone of a size-less actor paints nothing.
 * Such containers are cloned piece by piece instead.
 */
function isHollow(actor) {
    const [w, h] = actor.get_size();
    return actor.visible && (w <= 0 || h <= 0) &&
        (actor.get_n_children() > 0 || actor instanceof Meta.WindowGroup);
}

/**
 * Everything Clutter paints before `actor`, bottom-most first. Hollow
 * containers on the way are added to `hollow`.
 */
function paintedBefore(actor, hollow) {
    const expand = a => {
        if (!isHollow(a))
            return [a];
        hollow.push(a);
        return a.get_children().flatMap(expand);
    };
    const out = [];
    let child = actor;
    for (let parent = actor.get_parent(); parent; child = parent, parent = parent.get_parent()) {
        const siblings = parent.get_children();
        out.unshift(...siblings.slice(0, siblings.indexOf(child)).flatMap(expand));
    }
    return out;
}

// Moving these moves an actor on screen without allocating it again.
const SHIFTS = ['translation-x', 'translation-y', 'scale-x', 'scale-y'];

/** Allocate a clone where its source is now, in stage coordinates. */
function placeClone(clone) {
    const source = clone.source;
    if (!source || !clone.visible)
        return;
    const [x, y] = source.get_transformed_position();
    const [w, h] = source.get_transformed_size();
    const b = box(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0,
        Number.isFinite(w) ? w : 0, Number.isFinite(h) ? h : 0);
    const moved = !clone.has_allocation() || !clone.get_allocation_box().equal(b);
    clone.allocate(b);
    // The blur behind has to be redone.
    if (moved)
        clone.queue_redraw();
}

/**
 * A clone that, whenever its source changes, has GNOME repaint everything
 * the blur spreads that change to, not just the source's own area. (GNOME
 * repaints only what changed; with a smaller area, pixels near the source's
 * edges would keep their old blur, which shows as hard-edged bands.)
 */
const SceneClone = GObject.registerClass({GTypeName: typeName('AcrylicClone')},
class SceneClone extends Clutter.Clone {
    _init(source, reach) {
        super._init({source, visible: source.visible});
        this._reach = reach;
    }

    vfunc_get_paint_volume(volume) {
        if (!super.vfunc_get_paint_volume(volume))
            return false;
        const origin = volume.get_origin();
        const r = this._reach;
        volume.set_origin(new Graphene.Point3D({x: origin.x - r, y: origin.y - r, z: origin.z}));
        volume.set_width(volume.get_width() + 2 * r);
        volume.set_height(volume.get_height() + 2 * r);
        return true;
    }
});

/** Clones of what's behind, each on its source's spot of the stage. */
const Scene = GObject.registerClass({GTypeName: typeName('AcrylicScene')},
class Scene extends Clutter.Actor {
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(alloc) {
        this.set_allocation(alloc);
        for (const clone of this.get_children())
            placeClone(clone);
    }
});

/** What's behind, blurred. The scene is shifted so the clones line up with the screen. */
const Frost = GObject.registerClass({GTypeName: typeName('AcrylicFrost')},
class Frost extends St.Widget {
    _init() {
        super._init({clip_to_allocation: true});
        this.scene = new Scene();
        this.add_child(this.scene);
        this.blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, brightness: 1});
        this.add_effect_with_name('wsnap-blur', this.blur);
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(alloc) {
        this.set_allocation(alloc);
        this.scene.allocate(box(0, 0, 0, 0));
        this.align();
    }

    /** Shifting is only a transform: no new allocation, so it's fine mid-layout. */
    align() {
        const [x, y] = this.get_transformed_position();
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return;
        if (this.scene.translation_x !== -x)
            this.scene.translation_x = -x;
        if (this.scene.translation_y !== -y)
            this.scene.translation_y = -y;
    }
});

/** Holds the frost, and an empty layer as large as the shadow, so the shader's offscreen buffer includes it. */
const Backdrop = GObject.registerClass({GTypeName: typeName('AcrylicBackdrop')},
class Backdrop extends St.Widget {
    _init() {
        super._init();
        this.bounds = new St.Widget();
        this.frost = new Frost();
        this.add_child(this.bounds);
        this.add_child(this.frost);
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(alloc) {
        // Acrylic allocates the layers itself, with the geometry it works out.
        this.set_allocation(alloc);
    }
});

export const Acrylic = GObject.registerClass({GTypeName: typeName('Acrylic')},
class Acrylic extends St.Widget {
    /**
     * radius: corner radius, blur: blur radius, both in logical pixels.
     * styleClass: CSS class of the glass: tint, border and, with the
     *   -wsnap-shadow property (box-shadow syntax), the drop shadow.
     * sources: a function returning the actors to show through the glass;
     *   by default, everything painted before this actor.
     */
    _init({radius = 12, blur = 40, styleClass = 'wsnap-glass', sources = null} = {}) {
        super._init({reactive: false});
        this._radius = radius;
        this._blurRadius = blur;
        this._sources = sources;
        this._clones = new Map();
        // Connections are tracked on this object, not on `this`, so stopping
        // never disconnects what a subclass connected for itself.
        this._links = {};
        this._watched = [];
        this._hollow = [];
        this._later = 0;
        this._allocating = false;
        this._shadow = null;
        this._shadowKey = '';
        this._margins = [0, 0, 0, 0];
        this._uniforms = new Map();

        this._backdrop = new Backdrop();
        this._frost = this._backdrop.frost;
        this._scene = this._frost.scene;
        this._shader = new GlassShader();
        this._backdrop.add_effect_with_name('wsnap-glass', this._shader);
        this.add_child(this._backdrop);

        this._glass = new St.Widget({style_class: styleClass});
        this._glass.connect('style-changed', () => {
            if (!this._allocating)
                this.queue_relayout();
        });
        this.add_child(this._glass);
        this.setTint('');

        this.connect('notify::mapped', () => this._syncMapped());
        this.connect('destroy', () => this._stop());
    }

    /** Inline style for the glass (tint colours). The corners always match the backdrop's. */
    setTint(style) {
        this._glass.set_style(`border-radius: ${this._radius}px; ${style}`);
    }

    /** Rebuild the view of what's behind right away (after restacking, say). */
    refresh() {
        if (this.mapped)
            this._rebuild();
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(alloc) {
        this.set_allocation(alloc);
        this._allocating = true;
        try {
            this._layout(alloc);
        } finally {
            this._allocating = false;
        }
    }

    _layout(alloc) {
        this._readShadow();
        // Whole pixels keep the shader's view of the offscreen texture exact.
        const w = Math.max(Math.round(alloc.get_width()), 1);
        const h = Math.max(Math.round(alloc.get_height()), 1);
        const [l, t, r, b] = this._margins;
        const full = box(0, 0, w, h);
        this._backdrop.allocate(full);
        this._backdrop.bounds.allocate(box(-l, -t, w + l + r, h + t + b));
        // Blur only what no ancestor clips away (the snap bar slides out
        // from behind the top of its screen): blurring in the emptiness
        // beyond would thin the glass. All of it clipped: a pixel that
        // can't be seen, so the blur always has something to work on.
        const [sx, sy] = this.get_transformed_position();
        this._frost.allocate(box(...this._unclipped(sx, sy, w, h) ?? [0, 0, 1, 1]));
        this._frost.align();
        this._glass.allocate(full);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._frost.blur.radius = Math.round(this._blurRadius * scale);
        this._updateShader(w, h, scale);
    }

    /** The part of (0, 0, w, h) that no ancestor clips away, in whole pixels; null if none. */
    _unclipped(sx, sy, w, h) {
        if (!Number.isFinite(sx) || !Number.isFinite(sy))
            return [0, 0, w, h];
        let x1 = sx, y1 = sy, x2 = sx + w, y2 = sy + h;
        for (let a = this.get_parent(); a; a = a.get_parent()) {
            if (!a.clip_to_allocation)
                continue;
            const [ax, ay] = a.get_transformed_position();
            const [aw, ah] = a.get_transformed_size();
            x1 = Math.max(x1, ax);
            y1 = Math.max(y1, ay);
            x2 = Math.min(x2, ax + aw);
            y2 = Math.min(y2, ay + ah);
        }
        const fx = Math.max(Math.floor(x1 - sx), 0), fy = Math.max(Math.floor(y1 - sy), 0);
        const fw = Math.min(Math.ceil(x2 - sx), w) - fx, fh = Math.min(Math.ceil(y2 - sy), h) - fy;
        return fw > 0 && fh > 0 ? [fx, fy, fw, fh] : null;
    }

    // -- The shader ----------------------------------------------------------

    _readShadow() {
        let node = this._glass.peek_theme_node();
        if (!node && this._glass.get_stage())
            node = this._glass.get_theme_node();
        let shadow = null;
        if (node) {
            const [found, spec] = node.lookup_shadow('-wsnap-shadow', false);
            if (found && spec && !spec.inset && spec.color.alpha > 0) {
                const c = spec.color;
                shadow = {
                    x: spec.xoffset,
                    y: spec.yoffset,
                    blur: spec.blur,
                    spread: spec.spread,
                    color: [c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255],
                };
            }
        }
        const key = JSON.stringify(shadow);
        if (key === this._shadowKey)
            return;
        this._shadowKey = key;
        this._shadow = shadow;
        // A Gaussian is gone (< 0.5%) three sigmas out; sigma is blur / 2.
        const reach = shadow ? 1.5 * shadow.blur + shadow.spread + 1 : 0;
        this._margins = shadow ? [
            Math.max(Math.ceil(reach - shadow.x), 0),
            Math.max(Math.ceil(reach - shadow.y), 0),
            Math.max(Math.ceil(reach + shadow.x), 0),
            Math.max(Math.ceil(reach + shadow.y), 0),
        ] : [0, 0, 0, 0];
        // Square, shadowless glass (the resize placeholders) needs no shader.
        this._shader.enabled = this._radius > 0 || !!shadow;
    }

    _updateShader(w, h, scale) {
        const [l, t, r, b] = this._margins;
        const radius = Math.min(this._radius * scale, w / 2, h / 2);
        const pixels = this.get_resource_scale?.() || 1;
        const s = this._shadow;
        this._setUniform('wsnap_map', offscreenBox(-l, -t, w + r, h + b));
        this._setUniform('wsnap_shape', [w, h, radius, pixels]);
        this._setUniform('wsnap_shadow', s
            ? [s.x, s.y, Math.max(s.blur / 2, 0.01) * Math.SQRT2, s.spread]
            : [0, 0, 1, 0]);
        this._setUniform('wsnap_shadow_color', s ? s.color : [0, 0, 0, 0]);
    }

    _setUniform(name, values) {
        const key = values.join(',');
        if (this._uniforms.get(name) === key)
            return;
        this._uniforms.set(name, key);
        this._shader.setUniform(name, values);
    }

    // -- Tracking what's behind ---------------------------------------------

    _syncMapped() {
        if (this.mapped)
            this._start();
        else
            this._stop();
    }

    _start() {
        this._stop();
        // Follow this actor and its ancestors moving, so the scene behind
        // stays lined up with the screen, and rebuild when anything is added
        // or removed along the way.
        for (let a = this; a; a = a.get_parent()) {
            this._watched.push(a);
            for (const prop of SHIFTS)
                a.connectObject(`notify::${prop}`, () => this.queue_relayout(), this._links);
            if (a === this)
                continue;
            // Ancestors are allocated in the middle of a layout pass, when
            // asking for another one would come too late: just realign.
            a.connectObject(
                'notify::allocation', () => this._frost.align(),
                'child-added', () => this._queueRebuild(),
                'child-removed', () => this._queueRebuild(),
                this._links);
        }
        global.display.connectObject('restacked', () => this._queueRebuild(), this._links);
        this._rebuild();
    }

    _stop() {
        for (const a of this._watched)
            a.disconnectObject(this._links);
        this._watched = [];
        global.display.disconnectObject(this._links);
        if (this._later) {
            global.compositor.get_laters().remove(this._later);
            this._later = 0;
        }
        this._dropClones();
    }

    /** Rebuild just before the next frame, once, after everyone else has restacked. */
    _queueRebuild() {
        if (this._later)
            return;
        this._later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            if (this.mapped)
                this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        this._dropClones();
        const sources = this._sources ? this._sources() : paintedBefore(this, this._hollow);
        // Containers cloned piece by piece: rebuild when their pieces change.
        for (const container of this._hollow) {
            container.connectObject(
                'child-added', () => this._queueRebuild(),
                'child-removed', () => this._queueRebuild(),
                this._links);
        }
        // How far the blur carries a change (its kernel reaches ~1.5 radii).
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const reach = Math.ceil(1.5 * this._blurRadius * scale) + 2;
        for (const source of sources) {
            if (!source)
                continue;
            // (A clone paints its source even when that's hidden.)
            const clone = new SceneClone(source, reach);
            this._scene.add_child(clone);
            this._clones.set(source, clone);
            source.connectObject(
                // Sources are allocated mid-layout too: place the clone
                // right away instead of asking for another pass.
                'notify::allocation', () => placeClone(clone),
                'notify::translation-x', () => this._scene.queue_relayout(),
                'notify::translation-y', () => this._scene.queue_relayout(),
                'notify::visible', () => (clone.visible = source.visible),
                'destroy', () => this._unclone(source),
                this._links);
        }
    }

    _unclone(source) {
        source.disconnectObject(this._links);
        this._clones.get(source)?.destroy();
        this._clones.delete(source);
    }

    _dropClones() {
        for (const source of [...this._clones.keys()])
            this._unclone(source);
        for (const container of this._hollow)
            container.disconnectObject(this._links);
        this._hollow = [];
    }
});
