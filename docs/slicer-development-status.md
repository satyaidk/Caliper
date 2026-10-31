# Slicer development status

**Current stage: P1S print files (phase 14).** Caliper slices a plate with Bambu's own P1S
profiles and writes a `.gcode.3mf` for microSD printing, gated by an independent pre-flight check.
The files have **not yet been printed on hardware** by this project. See ADR
[0008](adr/0008-p1s-print-files-from-fetched-profiles.md) for the design, and the checklist
below for what must be compared against Bambu Studio before calling it validated.

## Phase 14: printable P1S files

### Pipeline

| Step | Module | What it does |
| --- | --- | --- |
| Profiles | `src/lib/bambu/profiles.ts` | Fetches the P1S machine, process and filament profiles and the printer model ID from Bambu Studio `v02.08.02.61`, resolves `inherits` and `include`, caches them in IndexedDB, and refuses presets not marked P1S-compatible. |
| Settings | `src/lib/bambu/settings.ts` | Reads every slicing number from those profiles (index 0, the standard hotend; filament `nil` falls back to the machine). Validates against P1S limits; refuses plates the filament profile forbids (0 °C), such as PLA on the Engineering Plate. |
| Templates | `src/lib/bambu/template.ts` | Renders Bambu's machine start, end, layer-change and timelapse templates and the filament start/end code. Unknown variables and malformed conditionals are errors. |
| Toolpaths | `src/lib/toolpath.ts` | Slices in plate millimetres. Simplifies outlines and paths to Bambu's 0.0125 mm resolution. Applies elephant-foot compensation. Generates walls inside-out, shells, sparse grid, bridges, supports, skirt and brim, with seams aligned to the rear and nearest-neighbour ordering. |
| G-code | `src/lib/gcode.ts` | Relative extrusion, retraction and 0.4 mm Z-hop when a travel crosses the outline, a forced lift at each layer change, first-layer speed and acceleration, Bambu's cooling rules, overhang fan on bridges, `HEADER_BLOCK`, `; CHANGE_LAYER`, `; FEATURE:` and `M73` progress. |
| Pre-flight | `src/lib/bambu/preflight.ts` | Independent re-read of the finished text; see ADR 0008 for the full list. Download is blocked on any failure. |
| Package | `src/lib/bambu/package3mf.ts`, `md5.ts`, `thumbnail.ts` | Builds the plate archive with an uppercase MD5 of the G-code and PNG thumbnails rasterised from the toolpaths. |
| Worker | `src/viewer/sliceWorker.ts`, `slicer.ts` | Runs the pipeline off the main thread; Preview draws the returned toolpaths. |

### Measured results

Measured on this machine (Windows 11, Node 24, headless Chromium 1234) with the live pinned profiles,
0.20 mm Standard, Bambu PLA Basic, 15 % infill, 2 walls, Textured PEI:

| Model | Layers | Filament | Print estimate | Slice time | Pre-flight |
| --- | --- | --- | --- | --- | --- |
| 20 mm cube (Node) | 100 | 4.39 g | 7 min 8 s | 120 ms | pass |
| Sample gear, 49.9 × 49.97 × 8 mm (browser, end to end) | 40 | 6.9 g | 22 min 14 s | 5.7 s including profile download | pass |
| 4,000-facet cylinder, Ø40 × 2 mm (Node) | 10 | — | — | 0.35 s | pass |

The print estimate excludes the printer's own start sequence (heating, wipe, levelling, purge).

### Problems found and fixed while building it

- **Overflowing the call stack.** Spreading a large first layer into `Math.min(...)` overflowed the stack on the sample gear. Bounds are now computed with loops.
- **Apparent flow spikes.** Sub-0.01 mm segments from finely tessellated meshes made flow look erratic once coordinates were rounded to 0.001 mm; pre-flight flagged it. Paths are now simplified to 0.0125 mm, and E is computed from the coordinates as written.
- **Slow polygon maths.** Clipper's JavaScript port switches to BigInteger maths above 47,453,132 units. At a 1e6 scale in millimetres every plate coordinate exceeded that. The scale is now 1e5 (10 nm). A redundant `SimplifyPolygons` pass before each union was removed. A 4,000-facet slice dropped from 29 s to 0.35 s.

### Compared with a Bambu Studio file (2026-11-01)

Reference: a P1S `.gcode.3mf` sliced by Bambu Studio 02.08.01.55 (0.16 mm Optimal, Generic PLA in slot 3,
Textured PEI, 112 layers, 4.65 g). Its geometry is not in the archive, so per-model totals could not be
compared.

| Item | Result |
| --- | --- |
| Machine start and end sequence | **Identical**, line for line, to Caliper's render of the pinned template with that print's values, apart from the filament slot (`T2` there, `T0` for Caliper's single spool) and Bambu's `M73` progress lines. |
| Flush values | **Confirmed.** `M620.1 E F299.339 T240` equals Generic PLA's 12 mm³/s maximum flow and its 240 °C range top, as derived. |
| Purge-line feed | **Confirmed** for a flow-capped filament: `F4800` is 12 mm³/s. |
| Template numbers | Bambu writes 3 decimals; **fixed** (was 6). |
| Levelling area | Bambu writes whole millimetres, minimum down and maximum up (`G29 A X116 Y116 I24 J24`); **fixed**. |
| File head and tail | Bambu writes `M201`/`M203`/`M204`/`M205` limits, `M981` spaghetti detector on and off, `M1003 S0`, and `; filament:`; **added**. |
| Layer change, fans, retraction | **Same structure**: `; CHANGE_LAYER`, `Z_HEIGHT`, `LAYER_HEIGHT`, `G1 E-.8 F1800`, fans off on layer 1, then `M106 S255` and `M106 P2 S178` on layer 2. |
| OPC files | `[Content_Types].xml`, `_rels/.rels`, `model_settings.config.rels` **byte-identical**. |
| `slice_info.config`, `plate_1.json`, `filament_sequence.json` | Bambu's extra fields (`first_layer_time`, `<object>`, `<nozzle>`, `layer_filament_lists`, bounding boxes) and attribute order **added**. |
| `project_settings.config` | **Still differs.** Bambu writes 572 keys, Caliper 441. The 147 missing keys are Bambu Studio's built-in defaults, which are not in the JSON profiles. Per-filament arrays hold one entry per project filament. |

Still open:

1. **The 147 default settings.** bambox reports that firmware rejects files with missing keys. This is not confirmed for microSD printing.
2. **Hardware.** First print a 20 mm cube on Textured PEI with PLA, watching the start sequence and first layer.

## Completed in this change

- Added `src/lib/slicing.ts`: pure fixed/variable layer planning, first-layer
  height, linear profile interpolation, mid-layer cut positions, and a final
  partial layer. The Planner has a one-million-layer guard.
- Connected the existing Preview slider and sidebar layer readouts to that
  schedule. The current UI still selects a single fixed layer height; profile
  editing and adaptive-layer generation are not exposed yet.
- Added `sliceContours` to intersect a `TriangleSource` at the selected layer's
  mid-height, stitch closed contours, drop open chains, and retain disconnected
  inner rings so hollow regions stay outlines rather than filled areas.
- Added the contour line overlay to Preview. It updates on layer changes,
  model layout/orientation/visibility changes, and respects hidden parts.
  Interactive contour drawing is capped at 250,000 triangles; larger models
  still get the existing clipped layer preview and an explanatory notice.
- Added cube, cylinder, hollow-box, vertex-plane, and open-chain tests.
- Added `src/lib/remote.ts` for opening direct model URLs in memory, extracting
  filenames from URLs and `Content-Disposition`, and reporting likely browser
  CORS/network failures. It does not save files or use a third-party proxy.
- Added focused tests in `test/slicing.test.ts` and `test/remote.test.ts`.
- Recorded the MIT/AGPL boundary and phase-1 scope in ADR 0007.
- Added Bambu 3MF project-color handling in `src/viewer/loaders/3mf-colors.ts`:
  the saved filament palette and object/part extruder assignments are applied, and
  whole-face `paint_color`/`mmu_segmentation` assignments render with the exact
  palette colors. Standard ThreeMFLoader colors remain untouched. Encoded
  within-face paint subdivision is not yet tessellated by Caliper.
- Added editable AMS preview colors for imported multicolor 3MFs. The Filament
  panel offers named preset swatches and a custom color picker per used slot;
  the object list can assign an individual object to one of those slots. Object
  assignment is isolated even when Three.js geometry or materials are shared.
  The controls use expandable slot rows and responsive two-line object rows.
  These edits affect only the in-memory preview and do not rewrite or export the
  3MF. Intricate within-triangle paint subdivision is still unsupported.
- Implemented phase 3 in `src/lib/walls.ts` with the Boost-licensed Clipper
  offset library. `generateClassicWalls` produces fixed-width centerlines:
  wall 1 is inset by half the external width and each following wall by one
  spacing. It preserves nested holes, stops when offsets collapse, and rejects
  invalid settings. Preview draws two 0.45 mm centerlines in addition to the
  slice outline. This is a geometric preview only; gap fill, thin walls, and
  user-adjustable wall settings are not implemented.
- Added wall spacing/count, hole direction, concave corner, collapse, and
  invalid-setting tests.
- Implemented phase 4 in `src/lib/surfaces.ts`: neighboring layer differences
  classify exposed top/bottom regions, and horizontal solid shells propagate
  through the changing cross-section while retaining holes. The remaining area
  is reported as internal/sparse. Preview samples a bounded eight-layer window
  (three shell layers above the selected cut, four below) and highlights up to
  three top and bottom solid shells; its layer-height setting controls the sample spacing. Added tests for
  three top solid layers, upward bottom-shell propagation, changing contours,
  nested holes, zero shells, and invalid settings. This is classification only,
  not infill paths, bridges, or G-code.
- Implemented phase 5 in `src/lib/infill.ts`: clipped rectilinear paths alternate
  direction and rotate by 90 degrees on alternate layers, monotonic top paths
  keep a consistent direction, and grid infill creates two crossing path
  families. Density converts base line spacing with `spacing = line width /
  density`; Preview defaults to 20% sparse infill and lets users select a
  density from 10% to 100%. Paths are inset behind the two preview walls and
  retain holes and separate islands. This remains a 2D path preview; it does
  not itself generate extrusion or travel moves.
- Implemented phase 6 in `src/lib/gcode.ts`: the Preview tab's **Export
  experimental G-code** action generates centered paths for a single-material
  Bambu P1S-sized PLA profile from visible closed meshes. It converts bead
  cross-section to filament length, caps speed by volumetric flow, and emits
  layer, travel, retract, and extrusion moves. It adds two prime-skirt loops
  for single-material nozzle priming. The writer rejects invalid layers,
  off-bed paths, empty toolpaths, and excessive layer/path counts.
  Browser-side triangle and triangle-layer budgets limit the work.
- Added optional basic grid supports in `src/lib/supports.ts`: identify each
  layer's overhang beyond the previous layer's expanded region, project the
  unsupported area down to the build plate, avoid model intersections, and
  preserve a configurable Z contact gap (default 0.2 mm). The UI enables these
  supports by default. The support body is a simple 12% grid; dense contact
  interface is described under phase 8 below. Bridge direction, tree supports,
  support blockers, and support painting are not implemented.
- The prime skirt is not an AMS purge tower. The export is single-material and
  contains no Bambu machine startup, bed-mesh, vibration/flow calibration, AMS
  flush, or purge routines. Such commands must not be guessed or appended to a
  raw file: machine sequences are firmware/profile-controlled. The output has
  not been opened in Bambu Studio or validated on printer hardware; it is only
  for G-code viewer inspection and must not be sent to a printer. This does not
  constitute a production-ready slicer.
- Implemented phase 7's first speed/cooling pass in `src/lib/gcode.ts`.
  Independent path-role speeds now cover skirt, brim, wall,
  top/bottom/solid/sparse infill, support, support interface, and bridge; all
  are limited by the profile volumetric flow cap.
  Estimated layer duration uses extrusion and travel lengths. Layers predicted
  under 5 seconds slow toward the configured minimum speed, and fan output
  interpolates from 100% below 5 seconds to 20% at 60 seconds; the first layer
  keeps the fan off. G-code includes per-layer time comments and a total
  geometry/speed estimate. This estimate excludes acceleration, retraction
  delays, firmware motion planning and machine-specific cooling behavior.
- Implemented phase 8's support refinement in `src/lib/supports.ts`: the two
  support layers nearest each modeled overhang contact (after the configured
  0.2 mm air gap) are separated from the 12% grid body and filled as a denser
  60% rectilinear support interface. Interface lines use their own slower role
  speed. This improves the contact surface but does not yet include bridge
  direction detection, interface-flow tuning, support blockers, or tree
  supports.
- Added a selectable first-layer bed-adhesion mode to the experimental G-code
  export: a two-loop prime skirt, a five-loop attached brim, or none. Brim and
  skirt loops expand only outer model footprints (not holes), remain first
  layer only, and use distinct role speeds. The brim is a basic geometry
  feature without brim ears or hardware/Bambu Studio validation.
- Cross-checked the implementation against the roadmap's bridge flow, spacing,
  cooling, and monotonic infill descriptions. Fixed monotonic top infill so its
  direction stays consistent between layers. Added a toggleable phase-9 bridge
  pass (enabled by default) to Preview G-code: unsupported bottom regions away
  from the build plate are expanded 3 mm into the current model footprint for
  anchoring, and nearby support-interface coverage below is excluded. The
  initial path direction follows the candidate region's shorter bounding-box
  axis; bridge paths use `lineWidth + 0.05 mm` spacing, round-bead flow, a
  separate slower role speed, and bridge fan (100% in this illustrative
  profile). This is an independent
  geometry heuristic, not the slicers' bridge detector. Complex contours,
  partial support, and bridge-direction accuracy still need reference
  comparisons.
- Added phase 10 bridge-over-sparse-infill routing. The first top-shell layer
  whose area overlaps the previous layer's internal/sparse region is given the
  bridge role; its region is removed from ordinary top-skin paths, expanded
  toward the surrounding shell for anchoring, and printed with bridge spacing,
  round-bead flow, speed and fan. The heuristic is disabled at 100% infill and
  does not run on later top-shell layers. It does not calculate exact local
  unsupported gaps, so this is not equivalent to a slicer's bridge-over-infill
  detector.
- Added phase 11 infill-aware bridge direction. The bridge pass generates the
  previous layer's actual grid paths and chooses a cardinal bridge direction
  by maximizing path length crossed perpendicularly. Balanced grid families
  use the deterministic region-bounds fallback. This does not map each bridge
  span to its local supporting strands or reproduce a slicer's detector;
  compare direction and per-layer extrusion against reference G-code.
- Implemented phase 12 in `src/lib/bridges.ts`: Preview and experimental G-code
  now share the same bridge-over-sparse-infill region, direction, and path
  planner. Eligible paths appear as an amber overlay on the selected layer;
  first-layer and 100% infill bridge paths are omitted. The Preview legend
  distinguishes these heuristic bridge paths from the other illustrative
  infill paths. This improves visibility and consistency, not slicer parity.
- Implemented phase 13's Preview-only local span diagnostic. It intersects
  planned bridge paths with the generated sparse-infill paths below and draws
  the intervals between consecutive crossings in red. The complete bridge
  paths remain amber and G-code output is unchanged. This measures geometric
  gaps between heuristic support crossings; it does not predict physical
  sag/contact or reproduce a slicer's local bridge detector.

## Review fixes (2026-11-01)

A code and logic review of phases 3–13 found and fixed the following. Each has
a regression test.

- **Support units.** Overhang detection compared a millimetre step
  (`layer height / tan(threshold + 1°)`) with contours in viewer world units,
  which differ from millimetres by `worldPerMm` (about 8 ÷ the model's
  diagonal). The exporter now converts slices to plate millimetres before any
  geometry work, so supports, walls, infill and bridges share one unit. A test
  asserts identical G-code at two world scales.
- **Mirrored G-code.** The viewer is Y-up with +Z toward the viewer (the
  printer's front), but world Z was written directly as printer Y (which points
  to the back), mirroring every part. Printer Y is now negated world Z.
- **Preview shell window.** Surface classification treats the outermost sampled
  layers as exposed, and the five-layer window was too short for three shells,
  so the selected layer was always drawn as top and bottom shell. The window now
  extends one shell depth beyond the selected layer, plus one layer below for
  the bridge planner's previous layer.
- **Role partition.** Each role region was inset by two line widths on its own,
  leaving about four line widths of empty space wherever solid met sparse
  infill. Bridge regions were not clipped to the walls and were not removed from
  sparse or solid infill, so bridge paths overlapped walls and other infill.
  Exporter and Preview now clip every role to the area inside the walls and
  subtract bridge regions from all other roles.
- **Solid role.** The exporter's internal solid region (`solid − topShell −
  bottomShell`) was always empty and every top-shell layer was monotonic in the
  same direction. It now matches Preview: exposed top is monotonic, exposed
  bottom is monotonic, inner shells are rectilinear and rotate 90° per layer, and
  the top surface prints last on its layer.
- **Region unions.** Concatenating two regions' loops before normalisation made
  any loop inside another region's loop read as a hole, cutting overlaps out
  instead of merging them. `unionSurfaceRegions` normalises each region first.
- **Bridge flow.** Bridges used the 0.45 mm line width as the round thread
  diameter, about 27% more plastic than `Flow.cpp`'s bridging flow. The profile
  now has `nozzleDiameter` (0.4 mm); bridge flow and spacing (`d + 0.05 mm`)
  use it.
- **Supports.** Columns now stop when they land on the part, keep a contact gap
  above the part's surface as well as below the overhang, keep a 0.35 mm XY
  distance from the part, and ignore overhang slivers narrower than one line.
  Generation is a single top-down pass instead of one downward walk per
  overhang layer.
- **Underside bridges.** Sloped walls produce thin newly exposed strips on every
  layer, which were all treated as bridges. Strips narrower than one line width
  are now filtered out, and area resting on support from the layers below is
  excluded.
- **Cooling.** Slowdown was floored at `minimum speed ÷ first-layer speed`
  (40%), so very short layers stayed under the target time. The scale is now
  `layer time ÷ target`, and the per-path minimum print speed is the only lower
  limit. The time estimate re-runs with the cooled feed rates instead of dividing
  travel time by the scale. The bridge fan now applies only while bridge paths
  print, and the layer fan resumes afterwards.
- **Overhang recompute.** Adding the infill-density setting moved
  `scheduleOverhang()` out of `setOverhangDeg`, so changing the overhang angle
  no longer refreshed overhang area. It is restored.

## Important link limitation

Browsers cannot read a cross-origin response unless its host permits it with
CORS headers. Caliper is a static client-side app, so there is no safe local
code change that can bypass that host policy. The working link path supports
public direct-file URLs whose servers allow browser access; extensionless
download endpoints also need an accessible `Content-Disposition` filename or
a supported filename in the URL. Do not add a public CORS proxy: it would send
user-supplied URLs and model bytes to a third party and would not be a reliable
production fix.

MakerWorld model pages do not expose CORS-readable API data to the static app.
Caliper now uses a constrained same-origin metadata endpoint to list a page's
public print profiles, model files, thumbnails, and reference gallery. Users
can inspect reference images, select a profile and STL file, and choose a
preferred 3MF or STL format before continuing to the selected profile on
MakerWorld. The model metadata exposes file names and image thumbnails, but not
the mesh URL. The profile preview endpoint
(`GET /design-service/instance/{id}/f3mf?type=preview`) also returned
“Please log in to download models” without MakerWorld authentication, so
Caliper cannot fetch a mesh for an interactive 3D viewer from its public
catalogue request. The chooser now explains this and links directly to the
selected profile's interactive preview on MakerWorld. Downloading the actual
mesh remains in MakerWorld's authenticated UI; then use **Open a model** in
Caliper. The endpoint only fetches fixed MakerWorld metadata routes for numeric
model IDs; it is not an arbitrary URL proxy. Direct file URLs hosted elsewhere
still work when their servers permit browser access.

## Next steps

1. Compare bridge direction, per-layer role extrusion, and support-interface
   behavior with Bambu Studio/PrusaSlicer G-code viewer output; do not print the
   experimental file. For safe printing, build a handoff that Bambu Studio
   itself slices with its own machine profile/startup, purge, and calibration.
2. Keep geometry and slicing computation framework-free. Move the interactive
   contour pass to a Web Worker before raising its triangle limit.
3. Compare bridge-over-infill roles, direction, and extrusion with real slicer
   output; improve local support-span analysis, then continue with richer
   support controls. Do not claim
   printer-ready output without slicer compatibility checks and controlled
   hardware validation.

The original research is `docs/slicer-logic.md`; architecture and licensing
decisions are in `docs/adr/0007-slicer-core-layer-planning.md`. Do not port or
bundle Bambu Studio code: it is AGPL-3.0, while Caliper remains MIT.

## Verification run (phase 14)

- `npm run typecheck` — passed.
- `npm test` — passed (291 tests).
- Headless Chromium end to end: open sample, slice, preview, download, unzip and verify MD5 — passed.
- `npm run build` — passed.
- `npm run contrast` — passed (60 text pairs).
- `git diff --check` — passed.
