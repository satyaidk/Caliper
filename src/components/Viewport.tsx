import { useEffect, useRef } from 'react';
import { Engine } from '@/viewer/Engine';
import { useViewer } from '@/store/useViewer';
import { dim } from '@/lib/format';
import { useIsCompact } from '@/hooks/useMediaQuery';
import { EmptyState } from './EmptyState';
import { Gizmo } from './Gizmo';
import { ToolButtons } from './ToolRail';
import { IconClose } from './Icons';

/** What a half-finished measurement is still waiting for. */
const PROMPT: Record<string, string[]> = {
  distance: ['Click the first point', 'Click the second point'],
  diameter: ['Click a point on the circle', 'Click a second point', 'Click a third point'],
};

/**
 * The readout tape shows one thing: whatever is live right now. Measuring beats
 * hovering beats selection, and when none of those apply the viewport is left
 * alone. Steady facts about the file live in the panel and the status strip, so
 * nothing is printed twice.
 */
function Readout() {
  const tool = useViewer((s) => s.measureTool);
  const pending = useViewer((s) => s.pendingPoints);
  const hover = useViewer((s) => s.hover);
  const selection = useViewer((s) => s.selection);

  if (tool !== 'off') {
    const steps = PROMPT[tool] ?? [];
    return (
      <div className="tape" data-tone="active">
        <span className="tape-k">{tool}</span>
        <span className="tape-v">{steps[pending] ?? 'Placing…'}</span>
        <span className="tape-step">
          {pending + 1}
          <i>/</i>
          {steps.length}
        </span>
      </div>
    );
  }

  const shown = hover ?? selection?.name;
  if (!shown) return null;

  return (
    <div className="tape" data-tone={hover ? 'hover' : 'held'}>
      <span className="tape-k">{hover ? 'Under cursor' : 'Selected'}</span>
      <span className="tape-v">{shown}</span>
    </div>
  );
}

/**
 * Measurement tags. Positions come straight from the engine on every rendered
 * frame and are written to the node's transform by hand — routing sixty
 * position updates a second through React state would re-render the panel and
 * the status strip along with them.
 */
function MeasureLabels() {
  const engine = useViewer((s) => s.engine);
  const measurements = useViewer((s) => s.measurements);
  const unit = useViewer((s) => s.unit);
  const remove = useViewer((s) => s.removeMeasurement);
  const nodes = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    if (!engine) return;
    engine.setLabelSink((anchors) => {
      for (const anchor of anchors) {
        const node = nodes.current.get(anchor.id);
        if (!node) continue;
        node.style.transform = `translate(-50%, -50%) translate(${anchor.x}px, ${anchor.y}px)`;
        node.style.visibility = anchor.behind ? 'hidden' : 'visible';
      }
    });
    return () => engine.setLabelSink(null);
  }, [engine]);

  if (!measurements.length) return null;

  return (
    <div className="tags" aria-hidden>
      {measurements.map((measurement) => (
        <div
          key={measurement.id}
          className="tag"
          ref={(node) => {
            if (node) nodes.current.set(measurement.id, node);
            else nodes.current.delete(measurement.id);
          }}
        >
          <span className="tag-value">
            {measurement.tool === 'diameter' && 'Ø '}
            {dim(measurement.value, unit)}
          </span>
          <button
            className="tag-drop"
            onClick={() => remove(measurement.id)}
            aria-label="Delete this measurement"
            tabIndex={-1}
          >
            <IconClose size={10} />
          </button>
        </div>
      ))}
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

/**
 * The browser can take the GPU context away at any time — a driver reset, a
 * laptop waking up, too many live canvases in other tabs. Saying so beats
 * leaving a black rectangle and letting the person guess.
 */
function ContextLost() {
  const lost = useViewer((s) => s.contextLost);
  if (!lost) return null;

  return (
    <div className="veil" role="alert">
      <div className="veil-frame">
        <strong>The graphics context was interrupted</strong>
        <span>
          The browser reset the GPU connection. Rendering resumes on its own; reload the page if it
          does not.
        </span>
      </div>
    </div>
  );
}

export function Viewport({ dragging, onOpen }: { dragging: boolean; onOpen: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const attach = useViewer((s) => s.attach);
  const detach = useViewer((s) => s.detach);
  const status = useViewer((s) => s.status);
  const measuring = useViewer((s) => s.measureTool !== 'off');
  const isCompact = useIsCompact();

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const store = useViewer.getState();
    const engine = new Engine(canvas, {
      onFrame: store.setFrame,
      onHover: store.setHover,
      onMeasure: store.setMeasurements,
      onMeasureRejected: (reason) =>
        store.toast({ tone: 'info', title: 'Nothing to measure there', text: reason }),
      onSelect: store.setSelection,
      onContextChange: (lost) => {
        store.setContextLost(lost);
        store.toast(
          lost
            ? {
                tone: 'error',
                title: 'The graphics context was interrupted',
                text: 'The browser reset the GPU connection.',
              }
            : { tone: 'success', title: 'Rendering resumed' },
        );
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
  }, [attach, detach]);

  const showEmpty = status === 'idle';

  return (
    <div className="stage" ref={hostRef} data-measuring={measuring}>
      <canvas ref={canvasRef} aria-label="3D viewport" />

      {showEmpty && <EmptyState onOpen={onOpen} />}

      {!showEmpty && (
        <>
          <MeasureLabels />
          <div className="stage-overlay">
            <div className="overlay-row">
              <Readout />
              <Gizmo />
            </div>
          </div>
        </>
      )}

      {isCompact && !showEmpty && (
        <nav className="dock" aria-label="View tools">
          <ToolButtons />
        </nav>
      )}

      <Progress />
      <ContextLost />

      {dragging && (
        <div className="veil">
          <div className="veil-frame">
            <strong>Drop to open</strong>
            <span>Folders are fine — textures and materials come along</span>
          </div>
        </div>
      )}
    </div>
  );
}
