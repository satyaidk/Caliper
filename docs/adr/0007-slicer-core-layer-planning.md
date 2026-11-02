# 0007: Start an independent slicer core with layer planning

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

Caliper's layer slider only divided model height by a fixed layer height. The
research in [slicer-logic.md](../slicer-logic.md) recommends a staged slicer
implementation and notes that both Bambu Studio and PrusaSlicer are AGPL-3.0,
while Caliper is MIT. The first step must be small, visible and testable without
copying either slicer's source.

Options considered:

1. Keep the existing uniform layer estimate and defer slicing.
2. Port Bambu Studio's slicer code or bundle its AGPL-licensed binaries.
3. Implement the general layer-planning behavior independently in TypeScript,
   using the report and public concepts as references.

## Decision

Choose option 3. Caliper remains MIT; no Bambu Studio or PrusaSlicer source,
assets or compiled code are incorporated. The first phase adds a pure
`generateLayerPlan` function with fixed layer heights, first-layer height,
linearly interpolated variable-height profiles, and a final partial layer that
ends exactly at the model top. The Preview slider and layer readouts use each
layer's mid-height, the plane used to represent a layer's geometry.

This is the foundation only, not a claim that Caliper can produce printer-ready
G-code. Outlines, walls, surfaces, infill, flow, G-code and printer-specific
behavior remain subsequent phases and require their own tests.

## Consequences

- The Preview tab now has an explicit per-layer schedule instead of assuming
  every layer is the same height.
- The planner has no React or three.js dependency and can be tested in Node.
- Variable profiles are linearly interpolated between strictly increasing Z
  points. Adaptive-height selection and profile editing are not included.
- A very short final layer is retained to ensure the visual plan reaches the
  part's top; printer-specific minimum-height constraints remain future work.
- Comparisons against Bambu Studio remain behavioral comparisons; no code is
  copied from its AGPL-licensed implementation.
