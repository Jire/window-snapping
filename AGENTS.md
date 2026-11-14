# AGENTS.md

Guidance for AI coding assistants (Claude Code, Codex, Copilot, Cursor and others) working in this repository or helping someone install or use it.

## What this is

Window Snapping is a GNOME Shell extension (GJS, ES modules) that brings Windows 11's window snapping to GNOME: dragging to edges and corners with a live preview, the drag-to-top snap layouts bar, Snap Assist, Windows-style Super+Arrow keys, Super+Z snap layouts, joint resizing of snapped windows and restoring their size when dragged away.

- UUID: `window-snapping@jire.github.io`
- Supported GNOME Shell: 46–51. Developed on 51; the automated scenarios below also pass on 46, 48, 49 and 50 (47 sits between 46 and 48 and uses the same code paths).
- License: GPL-2.0-or-later

## Helping someone install it

Point them to the one-line installer in [README.md](README.md#install). It installs per user (never with `sudo`) and turns off conflicting tiling extensions (Ubuntu ships its Tiling Assistant enabled); `--uninstall` turns those back on. On Wayland the extension loads at the next login; to load it without logging out, use the Looking Glass line in the README. Settings: `gnome-extensions prefs window-snapping@jire.github.io`.

If something doesn't snap, have them turn on **Debug logging** in the settings and run `journalctl --user -f -g window-snapping` while they reproduce it.

## Layout

| Path | Purpose |
| --- | --- |
| `extension/` | Everything that ships in the extension zip |
| `extension/extension.js` | Entry point: wires the parts together, turns GNOME's edge tiling off while enabled (backed up in our settings so a crash can't lose it) |
| `extension/snapper.js` | The snapping engine: zones, snapped-window records, restore geometry, the tiled look, snap fill, reflow on work area changes |
| `extension/dragSnap.js` | Title-bar drags: grab handling, pointer tracking, edge/corner hit-testing (incl. edges shared between monitors), restoring on drag, Esc |
| `extension/acrylic.js` | `Acrylic`, the frosted glass behind every overlay (see "Glass" below) |
| `extension/preview.js` | The snap preview shown while dragging, and `insetRect()` for its gaps |
| `extension/snapBar.js` | The snap layouts bar that drops down near the top while dragging |
| `extension/layoutPicker.js` | Layout thumbnails, shared by the snap bar and the Super+Z flyout |
| `extension/flyout.js` | Super+Z flyout with Windows' number-key selection |
| `extension/snapAssist.js` | Snap Assist: thumbnails of other windows in the free space |
| `extension/keyboard.js` | Super+Arrow state machine (custom handlers on GNOME's own bindings), Super+Alt+Up/Down, Super+Z |
| `extension/resize.js` | Joint resize (with frosted placeholders over windows that follow) and vertical maximize by dragging the top/bottom edge |
| `extension/animation.js` | Window morph animation (snapshot + guarded freeze/thaw) and the animation policy |
| `extension/geometry.js` | Pure geometry: zones, hit-testing, layouts, Snap Assist free space. No Shell imports; unit-tested |
| `extension/compat.js` | Every API that differs between GNOME 46 and 51, in one place |
| `extension/gtype.js` | `typeName()`: GObject type names unique to each loaded copy, so reloading without logging out works |
| `extension/prefs.js` | Preferences window (libadwaita) |
| `extension/stylesheet.css` | Styles; accent colours are applied from JavaScript |
| `extension/schemas/` | GSettings schema XML only. GNOME 44+ and `install.sh` compile it at install time; don't commit or ship `gschemas.compiled` |
| `tests/geometry.test.js` | Unit tests: `gjs -m tests/geometry.test.js` |
| `scripts/hot-load.js` | Looking Glass loader for reloading without logging out. Not shipped in the extension zip; `install.sh` puts it in `~/.local/share/window-snapping/` |
| `install.sh` | User-facing installer (curl/wget pipe), also `--uninstall`, `--version`, `--zip`, `--keep-conflicts` |
| `scripts/build.sh` | Builds `dist/<uuid>.shell-extension.zip` |
| `.github/workflows/ci.yml` | Syntax check, ESLint, unit tests, schema check, ShellCheck, build; publishes a release on `v*` tags |

## How it works, briefly

- **Dragging.** On `grab-op-begin` for a mouse move, a snapped or maximized window is restored right away to its pre-snap size, placed so the pointer keeps the same relative spot on it. Mutter positions dragged windows by a relative anchor (since 46), so it stays under the pointer for the rest of the drag. The pointer is followed with the cursor tracker's `position-invalidated` (`track_position()` is needed on 46–48). Esc is detected at `grab-op-end` by the primary button still being held.
- **Snapping.** Maximize flags are changed first and `move_resize_frame()` comes last (the last request wins; Mutter recomputes the other direction otherwise). With no gap, full-height zones are vertically maximized and full-width ones horizontally, because that's the only way Mutter tells apps a window is tiled (square corners). GNOME's own size-change animation is skipped (`skipNextEffect`, then any unused skip is cleared) and `animation.js` animates instead.
- **Snap bar.** It only shows once the pointer has rested near the top for `REST_MS` (moving more than `REST_SLOP` restarts the wait, and a timer rechecks a pointer that doesn't move), so the whole top edge, centre included, maximizes until then.
- **Restore geometry.** Each snapped window remembers the floating geometry from before its first snap. Drag-initiated snaps remember the geometry from before the drag. A snapped window maximized by other means (double-click, button) is restored to that geometry, like Windows.
- **Keys.** `Meta.keybindings_set_custom_handler()` on `toggle-tiled-left/right`, `maximize` and `unmaximize`, so users keep their own key choices. GNOME 46–47 call handlers as `(display, window, binding)`, later versions add the event before the binding. Super+Alt+Up/Down collide with GNOME Shell's `shift-overview-up/down`; those are set aside in `org.gnome.shell.keybindings` while the extension runs (backed up in `saved-shell-keybindings`), because Mutter picks one of two bindings for the same key at random.
- **Glass.** Never use `Shell.BlurEffect` in `BACKGROUND` mode: it blurs a copy of the framebuffer, and GNOME only repaints damaged regions, so the copy is partly stale and shows hard-edged bars. `Acrylic` instead clones the actors painted before it (or the sources it's given; containers without a size of their own, like the window groups, child by child, because on 46–50 a clone of a size-less actor paints nothing), blurs them in `ACTOR` mode in its own buffer, then one shader pass (`Shell.GLSLEffect` on 46–50, `Clutter.ShaderEffect` snippets on 51) cuts the antialiased rounded corners, draws the drop shadow outside the glass only (CSS `-wsnap-shadow`; a `box-shadow` would darken translucent glass unevenly) and dithers. The shader maps texture coordinates with Clutter's offscreen padding (`_clutter_actor_box_enlarge_for_effects()`, same on 46–51); Cogl rejects the blend string `Shell.GLSLEffect` sets, so every version blends premultiplied. Each clone's paint volume is its source's grown by the blur's reach, so a change behind the glass repaints everything the blur spreads it to. Clones are placed directly when their sources are allocated and the scene is shifted by a translation, so nothing queues a relayout mid-layout (Clutter warns "needs an allocation" otherwise).
- **Snap Assist** is modal (`pushModal`, `POPUP` action mode) and forwards Super+Arrow keys to the keyboard controller. Free space is computed in `geometry.freeZonesAfter()`.
- **State** lives in memory. `session-modes` includes `unlock-dialog` so locking the screen doesn't throw away which windows are snapped; all UI closes when the session locks, and keybindings only act in normal mode.

## Conventions

- Every `connect` needs a matching `disconnect` (use `connectObject` / `disconnectObject`), and `disable()` must undo everything `enable()` did: actors, timers, keybindings, GNOME settings.
- Mutter aborts the whole shell if a window actor is thawed more often than it was frozen. Only freeze through `animation.js`, which thaws exactly once and never touches a destroyed actor.
- APIs that differ between versions go through `compat.js`. In GJS, `get_pivot_point()` returns `[x, y]`; use `compat.vbox()` for vertical `St.BoxLayout`s.
- Register GObject classes with `GTypeName: typeName('Name')` from `gtype.js`: GJS refuses to register a type name twice in one session, which would break reloading.
- Start new source files with the SPDX header used in the existing files. Logging during normal operation goes through `ext.log()`, which only logs when the `debug` setting is on.

## Checking changes

```bash
npx --yes eslint@9 .
gjs -m tests/geometry.test.js
shellcheck install.sh scripts/*.sh
scripts/build.sh && ./install.sh --zip dist/*.shell-extension.zip
```

Then reload with the Looking Glass line from the README. Reloading the user's live session is their call, so ask before suggesting it.

### Testing in a headless GNOME Shell (never the live session)

**Isolate before starting the bus.** D-Bus-activated helpers inherit the environment of the bus daemon, not of the shell. A `dconf-service` started by a private bus that still has the real `XDG_CONFIG_HOME` writes test settings straight into the user's live dconf database (and two dconf services on one file overwrite each other's changes). So export the isolated environment *before* `dbus-run-session`, use `GSETTINGS_BACKEND=keyfile` so dconf is never involved, give it a private `HOME` and `XDG_RUNTIME_DIR`, and run everything in a transient scope so it can be stopped as a whole:

```bash
T=$PWD/test-env; mkdir -p $T/{home,config,data,state,cache}; mkdir -m700 -p /tmp/wsrt
systemd-run --user --scope --unit=wsnap-test.scope --collect \
  env -u DBUS_SESSION_BUS_ADDRESS HOME=$T/home XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data \
      XDG_STATE_HOME=$T/state XDG_CACHE_HOME=$T/cache XDG_RUNTIME_DIR=/tmp/wsrt GSETTINGS_BACKEND=keyfile \
  dbus-run-session -- gnome-shell --headless --wayland --no-x11 --wayland-display wsnap-test \
      --virtual-monitor 1920x1080 --virtual-monitor 2560x1440
systemctl --user stop wsnap-test.scope   # stops the shell and every helper it started
```

Keep `XDG_RUNTIME_DIR` short: Unix socket paths are limited to 108 bytes. Install the extension (and a throwaway extension that sets `global.context.unsafe_mode = true`) under `$T/data/gnome-shell/extensions`, and drive the shell over `org.gnome.Shell.Eval`: real input via `seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE / KEYBOARD_DEVICE)` makes GTK windows start real moves and resizes, and `Shell.Screenshot` captures the result (with the pointer, if asked). Turn off hot corners in the test session, or the virtual pointer may open the overview. Start test windows with `WAYLAND_DISPLAY=wsnap-test` and the same environment.

### Older GNOME versions

Build a root filesystem from the Arch Linux Archive without root privileges, and run it in bubblewrap with software rendering (no `/dev/dri`):

```ini
# pacman.conf
[options]
Architecture = x86_64
SigLevel = Never
DisableSandbox
[core]
Server = https://archive.archlinux.org/repos/2024/06/15/$repo/os/$arch
[extra]
Server = https://archive.archlinux.org/repos/2024/06/15/$repo/os/$arch
```

```bash
unshare -r -- pacman -Sy --root $ROOT --dbpath $ROOT/var/lib/pacman --config pacman.conf --noconfirm \
    gnome-shell gjs gtk4 libadwaita mesa dbus adwaita-icon-theme ttf-dejavu
```

Snapshots used: 46 = 2024/06/15, 48 = 2025/06/15, 49 = 2025/11/20, 50 = 2026/05/20. In the sandbox, bind `/etc/passwd`, `/etc/group`, `/etc/machine-id` and `/run/dbus` (GNOME 46 refuses to start without a system bus), start your own `dbus-daemon --address=unix:path=…` on a socket that's also visible outside, and talk to it with `gdbus call --address`. Launch test windows from inside the shell (`GLib.spawn_async`) so they use that version's GTK.

## Releasing

Tag and push (`git tag -a vN -m vN && git push origin vN`). CI builds the zip and attaches it to the GitHub release, and the installer always fetches `releases/latest`. Upload that same zip at [extensions.gnome.org/upload](https://extensions.gnome.org/upload/), which reviews each version before publishing it. Don't add a `version` key to `metadata.json`: extensions.gnome.org sets it. When a new GNOME version comes out, check the APIs listed at the top of `compat.js`, run the scenarios, then add it to `shell-version`.

Everything shipped in `extension/` must pass the [extensions.gnome.org review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html). Keep it free of build or dev files. Notes for the review: the `unlock-dialog` session mode is deliberate (locking the screen must not forget which windows are snapped; there's no UI or input handling on the lock screen), and the extension changes `org.gnome.mutter edge-tiling` and two `org.gnome.shell.keybindings` entries only while enabled, restoring them on disable.
