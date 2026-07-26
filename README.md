# Caliper

A 3D model viewer that runs entirely in the browser. Drop a file in and inspect
it — no upload, no account, no install. 18 formats across three pipelines: mesh,
CAD B-rep, and BIM.

Built with React 18, TypeScript 5 (strict) and three.js r169.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # type-checks, then bundles to dist/
npm run preview    # serve the production build
npm run typecheck  # types only
```

`dist/` is a static folder. Drop it on Netlify, Vercel, GitHub Pages, S3, nginx —
anything that serves files. There is no server component.

---

## Formats

| Pipeline | Formats | How it works |
|---|---|---|
| **Mesh** | `stl` `obj` `ply` `off` `gltf` `glb` `fbx` `dae` `3ds` `3mf` `amf` `wrl` | Triangles are read straight out of the file by three.js loaders. `off` uses a parser written for this project. |
| **CAD B-rep** | `step` `stp` `iges` `igs` `brep` `brp` `fcstd` `3dm` | Surfaces are tessellated on open. OpenCascade (`occt-import-js`) for STEP/IGES/BREP/FCStd, `rhino3dm` for 3DM. |
| **BIM** | `ifc` `bim` | `web-ifc` streams building elements; `.bim` (dotbim) is parsed directly from JSON with geometry instancing. |

**Companion files.** OBJ picks up a neighbouring `.mtl`; glTF picks up its `.bin`
and textures. Drop the whole folder in one go — folder drops are walked
recursively and every file is registered as a blob URL that the loaders resolve
against, so relative paths like `textures/wood.png` work without a server.

**Multi-file drops.** When several models arrive together, the largest one wins.
Companion extensions (`.mtl`, `.bin`, images) are never treated as the subject.

---

## Architecture

```
src/
├─ viewer/
│  ├─ Engine.ts             three.js scene, camera, controls, render modes,
│  │                        clipping, explode, picking, export
│  ├─ analyze.ts            stats, bounding box, scene tree, disposal
│  ├─ renderer-registry.ts  lets loaders reach the live renderer (KTX2 needs it)
│  └─ loaders/
│     ├─ index.ts           picks the primary file, routes to a pipeline
│     ├─ mesh.ts            the twelve three.js-backed formats
│     ├─ off.ts             hand-written OFF/COFF/NOFF/4OFF parser
│     ├─ dotbim.ts          dotbim JSON
│     ├─ occt.ts            STEP / IGES / BREP / FCStd
│     ├─ rhino.ts           3DM
│     └─ ifc.ts             IFC
├─ store/useViewer.ts       zustand store: load orchestration, display state
├─ hooks/                   drag-drop, media queries, command registry
├─ components/              rails, viewport, inspector, palette, toasts
└─ styles/                  tokens, base, ui
```

The `Engine` class owns everything imperative and knows nothing about React.
The store is the only bridge: React sets display state, the store forwards it to
the engine, and the engine reports selections and frame stats back.

**Normalisation.** Every model is wrapped in a framing group and scaled to a
fixed working diagonal. Doing it on a wrapper rather than the loaded root means a
file that places its geometry far from the origin still lands centred on the
grid, and lighting, shadow cascades and clipping distances stay predictable
whether the model is a bolt or a bridge. True dimensions are measured before
normalisation and reported in the inspector.

---

## Interface

**Tool rail** — five render modes (shaded, wireframe, shaded + edges, x-ray,
normals), grid and axes, section plane, explode, turntable, fit.

**Inspector** — three tabs:
- *Model*: axis-coded bounding box with a unit selector, geometry counts, file
  facts, and details of whatever is selected.
- *Tree*: the file's own hierarchy, with per-node visibility and isolate.
- *Display*: section plane, explode, surface colour, lighting, stage toggles.

**Command palette** (`⌘K` / `Ctrl+K`) — every command in one searchable list.
The palette and the keyboard shortcuts read from a single registry, so a shortcut
can never drift from its command.

**Export** — PNG of the current view at 2× device resolution, or the model as GLB
or STL.

### Keyboard

| | |
|---|---|
| `⌘K` | Commands |
| `⌘O` | Open a file |
| `Q W E X N` | Shaded · Wireframe · Edges · X-ray · Normals |
| `1`–`6`, `0` | Front, back, left, right, top, bottom, isometric |
| `F` | Fit to screen |
| `P` | Perspective ⇄ orthographic |
| `G` `A` `S` | Grid · Axes · Shadows |
| `C` | Section plane |
| `R` | Turntable |
| `I` / `⇧I` | Isolate the selection / show everything |
| `⌘S` | Save a PNG |
| `⌘B` | Inspector |
| `⌘J` | Dark ⇄ light |
| `Esc` | Clear the selection |

---

## Responsive behaviour

Below 860px the side rails collapse: tools move to a floating dock above the
safe-area inset, the inspector becomes a bottom sheet, and the view cube moves
clear of the dock. Touch gestures are handled by OrbitControls; `touch-action:
none` on the canvas keeps the page from scrolling under a drag.

The quality floor is held everywhere: visible keyboard focus, `prefers-reduced-
motion` respected, `aria` roles on the tab strip, switches, tree and dialogs.

---

## Design notes

The palette is derived from the one convention every 3D tool already shares —
the axis triad. X is red, Y is green, Z is blue, and those hues are used
literally: in the axes helper, on the section-plane axis picker, on the
bounding-box rows, and in the status strip. Z-blue doubles as the interface
accent, which keeps the chrome inside the model's own vocabulary instead of
importing a brand colour from outside it. Colour never means two things.

Type is Archivo (variable, set expanded for the wordmark) with IBM Plex Mono for
every number. All numerals are tabular so readouts don't jitter while orbiting.

The empty state is a format matrix grouped by pipeline rather than a flat list of
extensions, because the grouping predicts something real: mesh formats open
instantly, CAD formats pay a tessellation cost, BIM formats arrive pre-grouped
into building elements.

---

## Geometry kernels and offline use

The CAD and BIM kernels are WebAssembly builds in the 5–12 MB range. They are
fetched from a CDN the first time you open a file that needs one, so a session
that only ever opens an STL never downloads them.

To run fully offline, copy the dist folders of `occt-import-js`, `web-ifc` and
`rhino3dm` into `public/vendor/` and repoint the constants in `src/lib/cdn.ts`:

```ts
export const CDN = {
  occt: '/vendor/occt-import-js/',
  webIfc: '/vendor/web-ifc/',
  rhino3dm: '/vendor/rhino3dm/',
  draco: '/vendor/draco/',
  basis: '/vendor/basis/',
} as const;
```

Nothing else in the codebase references those URLs.

---

## Known limits

- Most formats carry no unit information. Caliper reads the file's numbers as
  millimetres by default; the unit selector in the inspector converts from there.
- The edge overlay has a 350,000-triangle budget. Past that it stops adding
  outlines rather than stalling the tab.
- Very large IFC models skip the per-element name lookup (one query each) above
  4,000 elements and fall back to express IDs.
- Point clouds are detected heuristically from PLY files with no faces and no
  normals.

---

## Licence

The application code is yours to use. Bundled dependencies keep their own
licences: three.js and fflate are MIT, `occt-import-js` wraps OpenCascade (LGPL),
`web-ifc` is MPL-2.0, and `rhino3dm` is MIT.
