# 0007: Slice in the browser, and check every G-code file before it can leave

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** the "non-goals: slicing and G-code" line in [design.md](../design.md)

## Context

Caliper stopped at the question "will this print?". People asked for the next
step: turn the plate into G-code for their printer. That changes what a bug
costs. A wrong measurement is a wrong number on a screen; a wrong G-code file
can drive a nozzle into a bed, cook a PTFE-lined hot end or grind filament
against a cold nozzle. The person asking was explicit: they cannot test blindly
on a real printer, so every file has to be verified before it reaches one.

[docs/slicer-logic.md](../slicer-logic.md) describes how PrusaSlicer and Bambu
Studio slice. Both are AGPL-3.0; Caliper is MIT (section 22.2 of that report).

Options considered for the slicer:

1. **Port PrusaSlicer's or Bambu Studio's code**, or compile it to WebAssembly.
   Proven output, but Caliper would have to become AGPL, and a WebAssembly
   build of libslic3r is a large, separate project.
2. **Send the model to a slicing service.** Breaks Caliper's rule that files
   never leave the device.
3. **Reimplement the pipeline in TypeScript** from the report: the same steps,
   rules and formulas, in our own code, with a Boost-licensed polygon library
   (Clipper 6, `clipper-lib`). Less capable at first, but MIT, local, and every
   line is ours to test.

Options considered for safety:

- **Trust the slicer.** Its tests would have to cover every way a file can be
  wrong, and they would not cover a person's pasted start sequence, a
  truncated download or a file from another slicer.
- **A separate checker that reads the finished text** as a printer would, with
  the printer's limits as the rules, and that export cannot bypass.

## Decision

Option 3 for slicing, and the separate checker for safety.

- `src/slicer/` is a pure TypeScript pipeline (layers → slice → walls →
  surfaces → toolpaths → G-code) with no DOM and no three.js. It runs in a Web
  Worker in the app and unchanged in Node's test runner.
- `src/slicer/verify.ts` parses the G-code **text** and checks homing,
  machine limits, temperatures against the printer's ratings, cold extrusion,
  feed rates, flow, blobs, retractions, unfilled placeholders, Z ordering, the
  end sequence and, for Caliper's own files, an integrity footer (declared
  extrusion total and end-of-file marker). The Preview draws the moves this
  parse collects, so what is shown is the file itself.
- Export requires: no errors, a result that is not stale (the plate and
  settings are fingerprinted at slice time), acknowledged warnings, and a
  first-print checklist about the physical printer.
- Printers ship a start sequence only where one can be written from public
  G-code standards without vendor-specific steps (Ender-3, Prusa MK4). Bambu
  Lab printers need nozzle wiping, AMS handling and calibration Caliper cannot
  reproduce safely, so their start sequence must be supplied by the person; the
  checker still verifies it.
- Any G-code file can be checked against a chosen printer, so files from other
  slicers get the same scrutiny.

## Consequences

- Caliper's licence stays MIT. Nothing in `src/slicer/` is copied or
  translated from AGPL code; the report is the only bridge.
- The slicer is deliberately smaller than the ones it learns from: classic
  fixed-width walls (no Arachne), grid and line infill, no supports (overhangs
  are reported instead, with a suggestion to reorient), no multi-material. Each
  is a later decision.
- The checker is conservative. Files from other slicers can trip it where
  vendor start sequences use the area beside the bed; those findings are
  warnings for external files and errors for Caliper's own.
- Profiles (`src/slicer/profiles.ts`) are now safety data. Changing a limit or a
  start sequence needs the same care as changing code, and a test.
- The checker is not a substitute for watching the first layer. The export
  dialog says so, and the checklist asks for it.
