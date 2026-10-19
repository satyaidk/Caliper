# 0006: Put several models on one plate, with one of them active

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

Caliper opened one file at a time. Opening a second replaced the first, a .zip
was rejected as an unknown format, and every file had to be chosen again after
the tab was closed. People asked for four things that all lead to the same
place:

1. open a .zip and choose which of its models to look at;
2. see several models at once;
3. colour each one separately, and move them around to lay them out;
4. reopen recently viewed models without choosing the files again.

The Engine was built around a single model: one `holder` (scale and seat), one
`pivot` (orientation), one scale factor fitted to that file, and every tool —
orient, explode, printability, measuring — wrote to those fields directly.

Options considered for the scene:

1. **One Engine per model**, each with its own canvas. Simple isolation, but N
   WebGL contexts (browsers cap them at about 16), no shared plate, and no way
   to see two parts side by side in one view.
2. **Merge every file into one object** and keep the single-model Engine. The
   tools would then treat two unrelated files as one assembly: auto orient
   would turn both together, printability would add their volumes, and the
   object list would mix their parts.
3. **A list of mounted models in one scene, with one active.** Each model keeps
   its own holder and pivot; tools that act on *a* model act on the active one,
   and things that describe the *plate* cover every visible model.

Options considered for scale:

- **Fit each model to the stage on its own.** Every part would look the same
  size, so a 10 mm screw would stand as tall as a 200 mm bracket beside it.
- **One shared world-per-millimetre scale**, set by the first model. Parts are
  their true sizes relative to each other, as on a slicer's plate.

## Decision

Option 3, with a shared scale.

- `Engine` keeps `models: Mounted[]` and `active`. Each `Mounted` owns its
  holder, pivot, parts, colour, unit, its own paint-over and overhang
  materials (they carry its colour), a footprint `spot` on the plate and a
  cached world `box`.
- `worldPerMm` is set when the first model is mounted and kept until the plate
  is empty, so the grid never jumps under the parts when another arrives. With
  one model, correcting its unit rebases the scale so the model keeps its size
  on screen (the old behaviour); with several, the model grows or shrinks
  against its neighbours, which is what correcting a unit means.
- **Active-model tools**: orient, lay on face, explode, printability, the
  object list, and the unit a measurement reads in. Clicking any part of
  another model makes that model active.
- **Plate-wide**: framing, the section cut, the Preview layer slider, the plate
  size, the printer fit check and the shadow frustum.
- **Moving** is a tool (`move`, key M). Its `pointerdown` listener is
  registered in the capture phase so it runs before OrbitControls' listener on
  the same canvas; a press on a model calls `stopImmediatePropagation()` and
  drags it across a horizontal plane at the grabbed height, while a press on
  empty canvas still orbits. Arrow keys nudge by one grid square, and the
  sidebar takes exact X/Z positions.
- **Arrange** (key T) is shelf packing of bounding rectangles
  (`lib/arrange.ts`), pure and unit-tested.
- **Zip archives** are read with fflate's async `unzip`, which inflates in Web
  Workers. Entries are filtered from the central directory before inflating,
  so only models and their companions cost memory. A zip holding one model
  opens directly; several open a chooser.
- **Recent models** live in IndexedDB (`lib/recent.ts`): the model file, only
  the companions its format can use, a thumbnail rendered through the real
  renderer with its own camera, and the colour and unit it was shown in. The
  last plate's layout is stored beside them. Eviction is least recently opened
  first, past 12 entries or 400 MB. A switch on Home turns it off, which also
  deletes everything already kept.

## Consequences

- One WebGL context however many models are open, and the existing
  single-file panels keep working unchanged: the store's `model` field is the
  active model.
- The plate is capped at 24 models. Past that the GPU, not the person, decides
  how responsive the page is.
- Measurements are anchored in world space, so moving, arranging or rescaling
  a model clears them rather than leaving them hanging in the air.
- Files are now stored on the device by default. They never leave it, clearing
  the browser's site data removes them, and the switch on Home removes them at
  once — but "nothing is stored" is no longer true, so the Home page says what
  is kept and where.
- Archive limits (1,000 entries, 1 GB uncompressed, 512 MB per entry) are
  checked against the sizes the archive's directory declares. An archive that
  lies about its sizes can still exhaust the tab's memory; it cannot reach
  anything outside it.
