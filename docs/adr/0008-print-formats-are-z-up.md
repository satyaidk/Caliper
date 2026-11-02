# 0008: Read print formats Z-up, and read 3MF with Caliper's own parser

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Two faults surfaced once Caliper started slicing (ADR 0007):

1. **Orientation.** STL and 3MF files opened lying on their side. A box modelled
   40 mm tall showed as 10 mm tall and 40 mm deep. The viewer is Y-up, but print
   formats are Z-up: 3MF and AMF say so in their specifications, and every
   slicer reads STL that way. A model that looks wrong is an annoyance; a model
   that is *sliced* wrong prints on its side.
2. **3MF.** three.js's `3MFLoader` could not open files from Bambu Studio or
   OrcaSlicer ("Cannot read properties of undefined (reading 'mesh')"). They use
   the 3MF Production extension: each object in its own file, every file
   numbering its objects from 1, and the loader keeps one id table for all
   files. It also ignored the model's unit, and drew slicer modifier volumes,
   negative volumes and support blockers as solid parts.

Options considered for orientation:

- **Leave files as they are** and rely on "lay on face". Every print file would
  need fixing by hand before slicing, and a person who forgets prints sideways.
- **Turn every format Z-up.** glTF is Y-up by specification, and FBX, Collada
  and the CAD kernels carry their own up axis.
- **Turn only the print formats (STL, 3MF, AMF) Z-up.** Matches the slicers for
  the files that are sent to printers; leaves formats with a defined or
  self-described up axis alone.

Options considered for 3MF:

- **Patch three.js's loader.** It is vendored example code with a single id
  table at its core; patching it means owning a fork.
- **A new reader** that resolves objects by (file, id), composes transforms,
  converts units and reads the slicers' project metadata.

## Decision

- STL, 3MF and AMF are read Z-up and turned a quarter about X into the viewer's
  Y-up frame. OBJ, PLY and OFF stay as they are: their files come from both
  worlds and have no convention to follow; "lay on face" fixes one in a click.
- 3MF is read by `src/viewer/loaders/threemf.ts`, pure code tested in Node
  (`test/threemf.test.ts`). It follows the package relationships to the root
  model, resolves components across files, applies build and component
  transforms (keeping mirrored triangles facing out), converts units to
  millimetres, reads colours, leaves out modifier, negative, support-enforcer
  and support-blocker volumes using Bambu Studio's `model_settings.config` and
  PrusaSlicer's `Slic3r_PE_model.config`, and reports G-code found in a sliced
  `.gcode.3mf`, which can then be checked (ADR 0007).
- The sample gear is written out Z-up, as a real print file would be.

## Consequences

- STL files reopened from the recent list now stand the way their designer
  modelled them, which may differ from how they looked before this change.
- Negative volumes are left out, not subtracted: Caliper does not do mesh
  booleans. The reader says so when it happens.
- The reader is a regular-expression scanner, not a general XML parser. It
  reads the elements 3MF defines; it does not validate the whole document.
