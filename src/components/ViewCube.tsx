import { useViewer } from '@/store/useViewer';
import type { ViewPreset } from '@/types';

/**
 * Nine cells, laid out the way the views sit around the model. Each label is
 * tinted by the axis the camera looks down, matching the gizmo and the
 * dimension readout — colour never means two different things in this app.
 */
type Cell =
  | { kind: 'view'; preset: ViewPreset; label: string; axis: 'x' | 'y' | 'z'; title: string }
  | { kind: 'fit' }
  | { kind: 'projection' };

const CELLS: Cell[] = [
  { kind: 'view', preset: 'top', label: 'TOP', axis: 'y', title: 'Look from the top' },
  { kind: 'view', preset: 'back', label: 'BCK', axis: 'z', title: 'Look at the back' },
  { kind: 'view', preset: 'iso', label: 'ISO', axis: 'x', title: 'Isometric view' },
  { kind: 'view', preset: 'left', label: 'LFT', axis: 'x', title: 'Look from the left' },
  { kind: 'fit' },
  { kind: 'view', preset: 'right', label: 'RGT', axis: 'x', title: 'Look from the right' },
  { kind: 'view', preset: 'bottom', label: 'BTM', axis: 'y', title: 'Look from below' },
  { kind: 'view', preset: 'front', label: 'FRT', axis: 'z', title: 'Look at the front' },
  { kind: 'projection' },
];

export function ViewCube() {
  const setView = useViewer((s) => s.setView);
  const frameAll = useViewer((s) => s.frameAll);
  const projection = useViewer((s) => s.display.projection);
  const setDisplay = useViewer((s) => s.setDisplay);

  return (
    <div className="viewcube" role="group" aria-label="Camera views">
      {CELLS.map((cell, i) => {
        if (cell.kind === 'fit') {
          return (
            <button
              key={i}
              className="viewcube-btn"
              data-role="center"
              onClick={frameAll}
              title="Fit the model to the screen"
            >
              FIT
            </button>
          );
        }
        if (cell.kind === 'projection') {
          return (
            <button
              key={i}
              className="viewcube-btn"
              onClick={() =>
                setDisplay('projection', projection === 'perspective' ? 'orthographic' : 'perspective')
              }
              title={
                projection === 'perspective'
                  ? 'Switch to orthographic projection'
                  : 'Switch to perspective projection'
              }
            >
              {projection === 'perspective' ? 'PSP' : 'ORT'}
            </button>
          );
        }
        return (
          <button
            key={i}
            className="viewcube-btn"
            data-axis={cell.axis}
            onClick={() => setView(cell.preset)}
            title={cell.title}
          >
            {cell.label}
          </button>
        );
      })}
    </div>
  );
}
