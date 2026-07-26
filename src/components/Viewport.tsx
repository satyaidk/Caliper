import { useEffect, useRef } from 'react';
import { Engine } from '@/viewer/Engine';
import { useViewer } from '@/store/useViewer';
import { compact } from '@/lib/format';
import { useIsCompact } from '@/hooks/useMediaQuery';
import { EmptyState } from './EmptyState';
import { ViewCube } from './ViewCube';
import { ToolButtons } from './ToolRail';

function Hud() {
  const frame = useViewer((s) => s.frame);
  const model = useViewer((s) => s.model);
  const selection = useViewer((s) => s.selection);
  if (!model) return null;

  return (
    <div className="hud">
      <div className="hud-cell">
        <span className="hud-k">Tris</span>
        <span className="hud-v">{compact(model.stats.triangles)}</span>
      </div>
      <div className="hud-cell">
        <span className="hud-k">Parts</span>
        <span className="hud-v">{compact(model.stats.meshes)}</span>
      </div>
      <div className="hud-cell">
        <span className="hud-k">Calls</span>
        <span className="hud-v">{frame.calls}</span>
      </div>
      <div className="hud-cell">
        <span className="hud-k">FPS</span>
        <span className="hud-v" data-state={frame.fps > 0 && frame.fps < 24 ? 'low' : undefined}>
          {frame.fps || '—'}
        </span>
      </div>
      {selection && (
        <div className="hud-cell">
          <span className="hud-k">Selected</span>
          <span className="hud-v">{selection.name.slice(0, 18)}</span>
        </div>
      )}
    </div>
  );
}

function Progress() {
  const status = useViewer((s) => s.status);
  const progress = useViewer((s) => s.progress);
  const note = useViewer((s) => s.progressNote);
  if (status !== 'loading') return null;

  return (
    <>
      <div className="loadbar">
        <div
          className="loadbar-fill"
          data-indeterminate={progress === null}
          style={{ width: progress === null ? undefined : `${Math.round(progress * 100)}%` }}
        />
      </div>
      <div className="loadcard">
        <span className="spinner" />
        <span>{note || 'Working'}</span>
        {progress !== null && <span className="mono">{Math.round(progress * 100)}%</span>}
      </div>
    </>
  );
}

export function Viewport({ dragging, onOpen }: { dragging: boolean; onOpen: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const attach = useViewer((s) => s.attach);
  const detach = useViewer((s) => s.detach);
  const setFrame = useViewer((s) => s.setFrame);
  const setSelection = useViewer((s) => s.setSelection);
  const setTab = useViewer((s) => s.setTab);
  const status = useViewer((s) => s.status);
  const isCompact = useIsCompact();

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const engine = new Engine(canvas, {
      onFrame: setFrame,
      onSelect: (info) => {
        setSelection(info);
        if (info) setTab('model');
      },
    });
    engine.resize();
    attach(engine);

    const observer = new ResizeObserver(() => engine.resize());
    observer.observe(host);

    return () => {
      observer.disconnect();
      detach();
      engine.dispose();
    };
  }, [attach, detach, setFrame, setSelection, setTab]);

  const showEmpty = status === 'idle';

  return (
    <div className="stage" ref={hostRef}>
      <canvas ref={canvasRef} aria-label="3D viewport" />

      {showEmpty && <EmptyState onOpen={onOpen} />}

      {!showEmpty && (
        <div className="stage-overlay">
          <div className="overlay-row">
            <Hud />
            {!isCompact && <ViewCube />}
          </div>
          <div className="overlay-row">
            <span />
            {isCompact && <ViewCube />}
          </div>
        </div>
      )}

      {isCompact && !showEmpty && (
        <nav className="dock" aria-label="Viewer tools">
          <ToolButtons compact />
        </nav>
      )}

      <Progress />

      {dragging && (
        <div className="veil">
          <div className="veil-frame">
            <strong>Drop to open</strong>
            <span>Folders are fine — companions come along</span>
          </div>
        </div>
      )}
    </div>
  );
}
