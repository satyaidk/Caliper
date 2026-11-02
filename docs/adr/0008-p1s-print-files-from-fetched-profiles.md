# 0008: Print P1S files built from Bambu's profiles, fetched at slice time

- **Status:** Accepted
- **Date:** 2026-11-01

## Context

Caliper's G-code export (phases 6–13) was for inspection only. It had a
generic `G28` start, absolute extrusion, no Z-hop, and no knowledge of the
P1S's excluded front-left corner, so it was never safe to print.

Printing on a Bambu Lab P1S safely requires Bambu's own machine sequence.
That sequence heats the printer, wipes the nozzle on the rear brush, homes Z
by touching the nozzle to the bed, levels the bed over the first-layer area,
runs mechanical checks and draws the purge line. It uses Bambu-only commands
(`G380`, `M1002`, `M970.3`, `M975`, `G29.2`). Guessing at them could damage the
printer. The sequence, the printer, process and filament profiles, and the
`project_settings.config` a `.gcode.3mf` carries all live in Bambu Studio,
which is AGPL-3.0. Caliper is MIT.

Options considered:

1. Ship hand-written start and end G-code.
2. Bundle Bambu's profiles and relicense Caliper as AGPL-3.0.
3. Ask the user to paste their own start and end G-code.
4. Fetch Bambu's profiles from its public repository at slice time, at one
   pinned release, and never bundle them.
5. Hand the plate to Bambu Studio and let it slice.

## Decision

Choose option 4, and write the plate-sliced `.gcode.3mf` format.

- **Pinned source.** Profiles are fetched from
  `raw.githubusercontent.com/bambulab/BambuStudio/v02.08.02.61/resources/profiles/BBL`
  under a fixed base URL. Names are validated, the `inherits` chain is bounded,
  and every value must be a string or a list of strings. Files are cached in
  IndexedDB.
- **Compatibility gate.** A preset is refused unless its profile lists
  `Bambu Lab P1S 0.4 nozzle` as compatible.
- **Fail-closed templates.** The machine templates are rendered by a small
  evaluator (`src/lib/bambu/template.ts`). An unknown variable, type mismatch
  or malformed conditional is an error, never an empty string.
- **Independent pre-flight.** A pre-flight pass (`src/lib/bambu/preflight.ts`)
  re-reads the finished G-code without sharing code with the generator.
  Download is blocked unless it passes. It checks:
  - plate bounds and the excluded corner;
  - Z limits;
  - heating before printing;
  - bed-levelling area;
  - relative extrusion and balanced retraction;
  - volumetric flow and machine speed and acceleration limits;
  - forbidden mid-print commands;
  - header totals;
  - that the start and end blocks match the rendered templates byte for byte.
- **Packaging.** The `.gcode.3mf` layout follows the MIT, hardware-tested
  bambox packer's documentation of what Bambu Studio writes. Bambu publishes
  no specification.

## Consequences

- No Bambu file ships with Caliper. A slice needs a network connection the
  first time each profile is used; after that, the IndexedDB copy serves it
  offline.
- **Profile drift.** Bambu can change its profiles only by a new tag.
  Updating `BAMBU_STUDIO_TAG` is a deliberate change. It must be followed by
  `npm test` and a fresh comparison against a Bambu Studio file.
- **Checks against a reference file.** Some format details are inferred and
  must be compared with a real Bambu Studio `.gcode.3mf` for the P1S. They are
  listed in [slicer-development-status.md](../slicer-development-status.md).
- **Scope.** Caliper's files are new and have not been printed on hardware
  by this project. The UI and README tell users to supervise first prints.
