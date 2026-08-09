import { useViewer } from '@/store/useViewer';
import { count, dim } from '@/lib/format';

const MODE_LABEL: Record<string, string> = {
  shaded: 'Shaded',
  wireframe: 'Wireframe',
  edges: 'Shaded + edges',
};

/**
 * Steady facts about the file, at the bottom edge and out of the way of the
 * model. Anything that changes as the cursor moves lives on the tape in the
 * viewport instead, so the two never say the same thing twice.
 */
export function StatusStrip() {
  const model = useViewer((s) => s.model);
  const unit = useViewer((s) => s.unit);
  const mode = useViewer((s) => s.display.renderMode);
  const frame = useViewer((s) => s.frame);

  if (!model) {
    return (
      <footer className="strip area-strip">
        <span className="strip-item">
          <span>Ready — drop a file anywhere to begin</span>
        </span>
      </footer>
    );
  }

  return (
    <footer className="strip area-strip">
      <span className="strip-item" data-axis="x">
        <b>W</b>
        <span>{dim(model.dimensions.x, unit)}</span>
      </span>
      <span className="strip-item" data-axis="y">
        <b>H</b>
        <span>{dim(model.dimensions.y, unit)}</span>
      </span>
      <span className="strip-item" data-axis="z">
        <b>D</b>
        <span>{dim(model.dimensions.z, unit)}</span>
      </span>

      <span className="strip-sep" />
      <span className="strip-item">
        <span>{count(model.stats.triangles)} triangles</span>
      </span>
      <span className="strip-sep" />
      <span className="strip-item">
        <span>{MODE_LABEL[mode] ?? mode}</span>
      </span>

      <span className="strip-spacer" />

      {frame.quality < 1 && (
        <span
          className="strip-item"
          data-tone="warn"
          title="Rendering below full resolution to hold the frame rate"
        >
          <span>{Math.round(frame.quality * 100)}% render scale</span>
        </span>
      )}
    </footer>
  );
}
