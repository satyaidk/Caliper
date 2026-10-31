# Changelog

All notable changes to Caliper. Versions follow [semantic versioning](https://semver.org).

## [Unreleased]

Several models on one plate, zip archives, and recently opened models.

### Added

- **Surface angle view (N).** A fourth display mode, after GitHub's STL
  viewer, that colours every surface by the direction it faces: red along +X,
  green up, blue towards the front. Flat faces read as one even colour, so
  chamfers, fillets and coarse facets stand out. Colours are tied to the plate,
  not the camera, so they stay put while orbiting.
- **Zip archives open.** A `.zip` is unpacked in the browser, reading only the
  entries a loader can use. One model inside opens directly; several open a
  chooser with a filter, Select all, folder, format and size for each.
  Textures and materials in the archive come along. Empty, damaged and
  password-protected archives say so instead of failing silently.
- **Several models on one plate**, up to 24, drawn at their true sizes relative
  to each other. Choosing or dropping several files opens them side by side;
  dropping onto an open plate, or File → Add models (Ctrl I), adds to it.
- **A colour per model.** Each new model takes a palette colour no other model
  is wearing. The Plate section's colour dots and the Filament swatches recolour
  models one at a time.
- **Moving and arranging.** A move tool (M) drags models across the plate,
  arrow keys nudge the active one a grid square, the sidebar takes exact X/Z
  positions, and Arrange (T) packs the plate. [ and ] step through models;
  Delete removes the active one.
- **Recently opened models**, with thumbnails, on the Home tab, kept in this
  browser's IndexedDB and reopened without choosing the file again. Restore
  the last plate brings every model back with its position and colour.
  Clearing site data empties it, and a switch turns it off and forgets
  everything kept.

### Changed

- **Open replaces, Add joins.** Ctrl O and the Open button start a fresh plate;
  Ctrl I, the Add button and drops onto an open plate add to it.
- **Plate-wide readouts.** Framing, the section cut, the Preview layer slider,
  the auto-sized plate, the printer fit check and shadows cover every visible
  model. The Size, Objects and Printability sections describe the active one.
- `Engine.setPlate(bed)` no longer takes a unit; each model's unit is set with
  `setModelUnit`. `Engine.setModel` still replaces the plate with one model.

### Added

- **Slice and print for the Bambu Lab P1S.** Print settings for filament, build plate, quality, infill, walls, adhesion and supports; slicing in a Web Worker with Bambu's own P1S profiles fetched from a pinned Bambu Studio release; a toolpath preview coloured by feature; and a `.gcode.3mf` download for microSD printing. See [ADR 0008](docs/adr/0008-p1s-print-files-from-fetched-profiles.md).
- **G-code preview.** Opening a `.gcode.3mf` or `.gcode` from Bambu Studio, OrcaSlicer, PrusaSlicer or Cura shows its toolpaths in Preview, coloured by feature, with the layer slider and the time and filament its slicer recorded. Arc moves are followed, and Bambu's purge line and nozzle wipe are left out. Preview only: Caliper does not check or re-export files it did not slice.
- **Pre-flight safety check.** Every print file is re-read independently before download. Download stays locked if any move leaves the plate or enters the excluded corner, Z exceeds 250 mm, flow or speed passes the limits, or the start and end sequence has been changed.

### Changed

- **A simpler start.** The Home tab and the website are shorter: open, slice, print. The old heuristic Preview overlays and the inspection-only G-code export are replaced by the real slicer.

### Fixed

- **Experimental G-code and slicer Preview.** Exported parts are no longer
  mirrored front to back. Supports measure overhangs in millimetres instead of
  viewer world units, keep XY and contact gaps, and stop on the part below.
  Bridge, solid and sparse paths stay inside the walls and no longer overlap
  each other. Bridges use nozzle-diameter flow. Short layers slow down to the
  minimum print speed. Preview no longer draws every layer as a solid shell.
  Changing the overhang angle refreshes the overhang area again. Details are in
  [docs/slicer-development-status.md](docs/slicer-development-status.md#review-fixes-2026-11-01).

## [2.0.0] — 2026-10-15

A redesign around Bambu Studio's interface, Bambu Studio's viewer tools, and a
split into a website and an installable app.

### Changed

- **The interface follows Bambu Studio.** A dark slate top bar with File menu
  and Home, Prepare and Preview tabs; a left sidebar of folding Printer,
  Filament, Objects, Size and File sections; a flat grey canvas with a floating
  toolbar for part tools and a view bar for display options. The palette comes
  from Bambu Studio's source, with lightness adjusted where its values fail WCAG
  AA. The typeface is Onest, the closest available match to Bambu's HarmonyOS
  Sans. Amber is replaced by Bambu green for active state and by orange for
  measurements.
- **The app moved to `/app/`.** The site root is now a website whose hero runs
  the real viewer on a generated gear. Old `/?model=…` links are forwarded.
- **Keys follow Bambu Studio.** Views are now 0 default, 1 top, 2 bottom,
  3 front, 4 rear, 5 left, 6 right, 7 isometric (previously 1–6 and 0). Fit is
  Z (was F), distance is U (was M). F is now lay on face.
- **STL shading** uses crease-angle normals: flat faces of CAD parts no longer
  shade with dark diagonal gradients, and curved scans stay smooth.
- **Tone mapping** is Khronos PBR Neutral instead of ACES, so filament colours
  render as the colour picked rather than a lighter pastel.
- **glTF, IFC and dotbim** files are read in metres by default, and every file's
  unit can be changed in the Size section.

### Added

- Lay on face (F) and auto orient (R), with the size readout following the new
  orientation.
- Angle measurement (A), alongside distance and diameter.
- Section view (X) along X, Y or Z, with a stencil-filled, hatched cap.
- Assembly view (Y): pull parts apart along lines from the centre, ratio 1–3.
- Preview tab: a layer slider at the chosen layer height, overhangs past a
  configurable limit painted red, and a printability check-up — closed surface,
  volume, solid-PLA weight, surface area and overhang area.
- Printer plates at true size for Bambu Lab X1/P1/A1, A1 mini, Prusa MK4 and
  Creality Ender-3, with a fit check that allows a quarter turn.
- Orthographic camera (K), part labels (L), overhang shading (O) in Prepare.
- Object list with per-part visibility, isolate and search, windowed for
  assemblies with thousands of parts.
- Filament colours, including painting over a file's own materials.
- A generated sample gear (`/app/?sample`), opening from a link on the Home
  tab, and `&tab=preview` deep links.
- Keyboard shortcuts dialog (?), driven by the same table as the keys.
- Installable PWA: PNG icons, maskable icon, screenshots, an app shortcut,
  window-controls overlay, and a service worker generated per build for offline
  use, with an in-app prompt when an update is ready.
- `npm run coverage` and `npm run contrast`; CI runs the contrast check.
- 59 new unit tests (98 in total) for orienting, printability, crease normals,
  printer beds and layers, label placement, the sample part and the new
  formatters.
- CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, LICENSE, issue and pull request
  templates, a design doc, five ADRs and a beginner learning path.

### Fixed

- Measurement tags that land in the same place, such as a hole's diameter and
  a span across the part, now stack instead of hiding each other.

## [1.0.1] — 2026-08-12

### Fixed

- **Every CAD and BIM format failed in production.** Opening a `.step`, `.stp`,
  `.igs`, `.brep`, `.fcstd` or `.3dm` file gave *"Evaluating a string as
  JavaScript violates the following Content Security Policy directive"*. The
  policy carried `'wasm-unsafe-eval'` but not `'unsafe-eval'`, and the Emscripten
  runtimes these kernels are built with need both — `rhino3dm` calls
  `new Function`, and Chrome reports blocked WebAssembly through the same
  message. Only the deployed site was affected; neither the dev server nor
  `npm run preview` sends headers.

### Added

- **Unit tests** — 39 of them, over number formatting, the format registry,
  `pickPrimary` and the measuring maths including every degenerate case. They
  use Node's built-in runner and its native TypeScript support, so there is no
  framework and no new runtime dependency. CI runs them on every push.
- **An end-to-end format sweep** in `e2e/`. It serves `dist/` with the headers
  read straight out of `vercel.json` and opens one real file per supported
  extension, asserting each renders. This is the harness that would have caught
  the bug above, and it now reports 19/19.
- `@types/node` as a dev dependency, so the tests typecheck.

## [1.0.0] — 2026-08-09

First release. A 3D model viewer that opens the file and tells you how big it is.

### Added

- **Opens 22 extensions** across three pipelines — mesh (`stl`, `obj`, `ply`,
  `off`, `gltf`, `glb`, `fbx`, `dae`, `3ds`, `3mf`, `amf`, `wrl`), CAD B-rep
  (`step`, `stp`, `iges`, `igs`, `brep`, `brp`, `fcstd`, `3dm`) and BIM (`ifc`,
  `bim`). Drag and drop, a file picker, or `?model=<url>`. Nothing is uploaded.
- **Size readout** — width, height and depth in the file's own units, plus the
  diagonal, with mm / cm / m / inch switching.
- **Measuring** — point-to-point distance, and diameter fitted through three
  points on an arc. Clicks snap to the nearest corner, edge midpoint or face
  centroid within 14 screen pixels. Distances also split per axis.
- **Viewing** — orbit, pan, zoom; shaded, wireframe and shaded-with-edges;
  build plate and shadows; an orientation gizmo that shows which way you are
  facing and jumps to any of the six straight-on views.
- **Selection** — click a part for its name and triangle count, and zoom to it.
- **PNG export** of the current view, at twice the screen resolution.
- Dark and light themes, remembered along with your view preferences.
- Installable as an app, with OS file handlers for model files.

### Engineering

- On-demand rendering: frames are drawn when something changes, not sixty times
  a second regardless. An adaptive quality governor drops the device pixel ratio
  when the frame rate falls under load and restores it when there is headroom.
- WebGL context loss is caught and recovered from, with an error boundary and a
  no-WebGL fallback behind it.
- CI runs typecheck and build on `main` and `dev`. Deployment is Vercel's git
  integration, so there is no deploy workflow to keep in step with it.

[2.0.0]: https://github.com/satyaidk/Caliper/compare/v1.0.1...v2.0.0
[1.0.1]: https://github.com/satyaidk/Caliper/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/satyaidk/Caliper/releases/tag/v1.0.0
