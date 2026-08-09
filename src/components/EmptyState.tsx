import { BY_PIPELINE, FORMATS, PIPELINE_COPY } from '@/lib/formats';
import { useViewer } from '@/store/useViewer';
import type { Pipeline } from '@/types';
import { IconOpen } from './Icons';

const ORDER: Pipeline[] = ['mesh', 'cad', 'bim'];

/**
 * Sample models are pulled on demand from the three.js example assets, so the
 * viewer has something to show without asking the visitor to find a file first.
 */
const SAMPLES: { label: string; url: string; filename: string }[] = [
  {
    label: 'Load a sample STL',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/r169/examples/models/stl/binary/pr2_head_pan.stl',
    filename: 'pr2_head_pan.stl',
  },
  {
    label: 'Load a sample glTF',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/r169/examples/models/gltf/DamagedHelmet/glTF-Binary/DamagedHelmet.glb',
    filename: 'DamagedHelmet.glb',
  },
];

export function EmptyState({ onOpen }: { onOpen: () => void }) {
  const openFromUrl = useViewer((s) => s.openFromUrl);

  return (
    <div className="empty">
      <div className="empty-head">
        <p className="eyebrow">Runs on this device · nothing uploaded</p>
        <h1 className="empty-title">
          Someone sent you a STEP file.
          <em>Open it. Measure it.</em>
        </h1>
        <p className="empty-sub">
          Drop a file anywhere on this page. Mesh, CAD and BIM formats all open the same way, and
          the measuring tools work on every one of them.
        </p>
      </div>

      {/* Outside the headline's measure: three buttons need more room than a
          comfortable line of prose, and wrapping one of them onto its own row
          makes it look like an afterthought. */}
      <div className="empty-cta">
        <button className="btn" data-variant="solid" onClick={onOpen}>
          <IconOpen size={16} />
          Choose a file
        </button>
        {SAMPLES.map((sample) => (
          <button
            key={sample.filename}
            className="btn"
            data-variant="ghost-line"
            onClick={() => openFromUrl(sample.url, sample.filename)}
          >
            {sample.label}
          </button>
        ))}
      </div>

      <section className="matrix" aria-label="Supported formats">
        <header className="matrix-head">
          <span className="eyebrow">Formats</span>
          <span className="eyebrow mono">{FORMATS.length} extensions · 3 pipelines</span>
        </header>

        {ORDER.map((pipeline) => (
          <div className="matrix-row" key={pipeline} data-kind={pipeline}>
            <div className="matrix-label">
              <b>{PIPELINE_COPY[pipeline].title}</b>
              <span>{PIPELINE_COPY[pipeline].note}</span>
            </div>
            <ul className="matrix-chips">
              {BY_PIPELINE[pipeline].map((spec) => (
                <li className="chip" key={spec.ext} title={spec.label}>
                  {spec.ext}
                </li>
              ))}
            </ul>
          </div>
        ))}

        <footer className="matrix-foot">
          STEP, IGES, BREP, FCStd and IFC are tessellated by WebAssembly kernels that download the
          first time you open one of those files. OBJ picks up a neighbouring .mtl, and glTF picks
          up its .bin and textures — drop the whole folder in one go.
        </footer>
      </section>
    </div>
  );
}
