# Changelog

All notable changes to Caliper. Versions follow [semantic versioning](https://semver.org).

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
- CI runs typecheck and build on `main` and `dev`; `main` deploys to GitHub
  Pages.

[1.0.0]: https://github.com/satyaidk/Caliper/releases/tag/v1.0.0
