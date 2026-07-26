import { useViewer } from '@/store/useViewer';
import { count, dim } from '@/lib/format';

export function StatusStrip() {
  const model = useViewer((s) => s.model);
  const unit = useViewer((s) => s.unit);
  const display = useViewer((s) => s.display);
  const frame = useViewer((s) => s.frame);
  const selection = useViewer((s) => s.selection);
  const togglePalette = useViewer((s) => s.togglePalette);

  return (
    <footer className="strip area-strip">
      {model ? (
        <>
          <span className="strip-item" data-axis="x">
            <b>X</b>
            <span>{dim(model.dimensions.x, unit)}</span>
          </span>
          <span className="strip-item" data-axis="y">
            <b>Y</b>
            <span>{dim(model.dimensions.y, unit)}</span>
          </span>
          <span className="strip-item" data-axis="z">
            <b>Z</b>
            <span>{dim(model.dimensions.z, unit)}</span>
          </span>
          <span className="strip-sep" />
          <span className="strip-item">
            <span>{count(model.stats.triangles)} triangles</span>
          </span>
          <span className="strip-sep" />
          <span className="strip-item">
            <span>
              {display.projection === 'perspective' ? 'Perspective' : 'Orthographic'} ·{' '}
              {display.renderMode}
            </span>
          </span>
          {selection && (
            <>
              <span className="strip-sep" />
              <span className="strip-item">
                <span>{selection.name}</span>
              </span>
            </>
          )}
        </>
      ) : (
        <span className="strip-item">
          <span>Ready — drop a file anywhere to begin</span>
        </span>
      )}

      <span className="strip-spacer" />

      <span className="strip-item">
        <span>{frame.triangles ? `${count(frame.triangles)} drawn` : ''}</span>
      </span>
      <span className="strip-sep" />
      <button className="strip-item" onClick={() => togglePalette(true)}>
        <span>Commands</span>
        <kbd className="kbd">⌘K</kbd>
      </button>
    </footer>
  );
}
