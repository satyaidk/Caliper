# Slicer development status

**Current stage: phases 1–2, layer planning and outlines.** This is not a
complete slicer and does not generate G-code. Continue from ADR
[0007](adr/0007-slicer-core-layer-planning.md) and the phased implementation
plan in [slicer-logic.md](slicer-logic.md#224-a-phased-plan).

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

1. Implement phase 3 from the research report: classic wall offsets, with
   correctness tests for spacing and wall count.
2. Keep the geometry and slicing computation framework-free. Move the
   interactive contour pass to a Web Worker before raising its triangle limit.
3. Then proceed through surface classification, infill, flow/G-code and
   supports as separately tested phases. Do not claim printer-ready output
   until phase 6 is complete and its output is validated in Bambu Studio.

The original research is `docs/slicer-logic.md`; architecture and licensing
decisions are in `docs/adr/0007-slicer-core-layer-planning.md`. Do not port or
bundle Bambu Studio code: it is AGPL-3.0, while Caliper remains MIT.

## Verification run

- `npm test` — passed (171 tests).
- `npm run build` — passed.
- `npm run contrast` — passed (60 text pairs).
- `git diff --check` — passed.
