import { PIPELINE_COPY, SHOWCASE, specFor } from '@/lib/formats';
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
    label: 'Try a sample STL',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/r169/examples/models/stl/binary/pr2_head_pan.stl',
    filename: 'pr2_head_pan.stl',
  },
  {
    label: 'Try a sample glTF',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/r169/examples/models/gltf/DamagedHelmet/glTF-Binary/DamagedHelmet.glb',
    filename: 'DamagedHelmet.glb',
  },
];

export function EmptyState({ onOpen }: { onOpen: () => void }) {
  const openFromUrl = useViewer((s) => s.openFromUrl);

  return (
    <div className="empty">
      <div className="empty-head">
        <p className="eyebrow">3D model viewer</p>
        <h1 className="empty-title">
          Open a model. <em>Measure it.</em>
        </h1>
        <p className="empty-sub">
          Drop a file anywhere on this page. Everything is read and rendered on this device —
          nothing is uploaded, and there is nothing to install.
        </p>

        <div className="empty-cta">
          <button className="btn" data-variant="solid" onClick={onOpen}>
            <IconOpen size={16} />
            Choose a file
          </button>
          {SAMPLES.map((s) => (
            <button
              key={s.filename}
              className="btn"
              data-variant="ghost-line"
              onClick={() => openFromUrl(s.url, s.filename)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <section className="matrix" aria-label="Supported formats">
        <header className="matrix-head">
          <span className="eyebrow">Formats</span>
          <span className="eyebrow mono">18 read · 3 pipelines</span>
        </header>

        {ORDER.map((pipeline) => (
          <div className="matrix-row" key={pipeline} data-kind={pipeline}>
            <div className="matrix-label">
              <b>{PIPELINE_COPY[pipeline].title}</b>
              <span>{PIPELINE_COPY[pipeline].note}</span>
            </div>
            <div className="matrix-chips">
              {SHOWCASE[pipeline].map((ext) => (
                <button
                  key={ext}
                  className="chip"
                  onClick={onOpen}
                  title={specFor(`x.${ext}`)?.label ?? ext.toUpperCase()}
                >
                  {ext}
                </button>
              ))}
            </div>
          </div>
        ))}

        <footer className="matrix-foot">
          STEP, IGES, BREP, FCStd and IFC are tessellated by WebAssembly kernels that download the
          first time you open one of those files. OBJ picks up a neighbouring .mtl, and glTF picks up
          its .bin and textures — drop the whole folder in one go.
        </footer>
      </section>
    </div>
  );
}
