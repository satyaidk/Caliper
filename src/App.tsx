import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useViewer } from '@/store/useViewer';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useIsCompact } from '@/hooks/useMediaQuery';
import { ACCEPT, baseOf } from '@/lib/formats';
import { TopRail } from '@/components/TopRail';
import { ToolRail } from '@/components/ToolRail';
import { Viewport } from '@/components/Viewport';
import { Panel } from '@/components/Panel';
import { StatusStrip } from '@/components/StatusStrip';
import { Toasts } from '@/components/Toasts';

/**
 * A model can be handed to the page by URL — `?model=https://…/part.step` —
 * which is what makes a link to a specific part shareable at all. Only http(s)
 * is honoured: anything else is a scheme the fetch has no business following.
 */
function modelFromUrl(): { url: string; name: string } | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('model');
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const name = params.get('name') || baseOf(decodeURIComponent(url.pathname)) || 'model';
    return { url: url.href, name };
  } catch {
    return null;
  }
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const open = useViewer((s) => s.open);
  const engine = useViewer((s) => s.engine);
  const model = useViewer((s) => s.model);
  const toast = useViewer((s) => s.toast);
  const openFromUrl = useViewer((s) => s.openFromUrl);
  const panelOpen = useViewer((s) => s.panelOpen);
  const sheetOpen = useViewer((s) => s.sheetOpen);
  const toggleSheet = useViewer((s) => s.toggleSheet);
  const theme = useViewer((s) => s.theme);
  const compact = useIsCompact();

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  const screenshot = useCallback(() => {
    if (!engine || !model) return;
    const link = document.createElement('a');
    link.href = engine.screenshot(2);
    link.download = `${model.name.replace(/\.[^.]+$/, '')}.png`;
    link.click();
    toast({ tone: 'success', title: 'Saved the view as PNG' });
  }, [engine, model, toast]);

  const dragging = useFileDrop((files) => void open(files));
  useHotkeys(useMemo(() => ({ open: openPicker, screenshot }), [openPicker, screenshot]));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Waits for the engine, because a model has nowhere to go without one.
  const requested = useRef(false);
  useEffect(() => {
    if (!engine || requested.current) return;
    const target = modelFromUrl();
    if (!target) return;
    requested.current = true;
    void openFromUrl(target.url, target.name);
  }, [engine, openFromUrl]);

  // Installed as an app, Caliper registers for model files. This is the half
  // that makes double-clicking an STL in the file manager actually land here.
  useEffect(() => {
    if (!engine || !('launchQueue' in window)) return;
    const queue = window.launchQueue as LaunchQueue;
    queue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map((handle) => handle.getFile()));
      if (files.length) void open(files);
    });
  }, [engine, open]);

  // Opening the same file twice in a row should still reload it.
  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length) void open(files);
    event.target.value = '';
  };

  return (
    <div className="shell" data-panel={panelOpen && !compact ? 'open' : 'closed'}>
      <TopRail onOpen={openPicker} onScreenshot={screenshot} />
      {!compact && <ToolRail />}

      <main className="area-stage">
        <Viewport dragging={dragging} onOpen={openPicker} />
      </main>

      {!compact && panelOpen && (
        <div className="area-panel">
          <Panel />
        </div>
      )}

      {!compact && <StatusStrip />}

      {compact && sheetOpen && (
        <>
          <div className="sheet-scrim" onClick={() => toggleSheet(false)} />
          <div className="sheet" role="dialog" aria-label="Model details">
            <button
              className="sheet-grab"
              onClick={() => toggleSheet(false)}
              aria-label="Close the details panel"
            />
            <Panel />
          </div>
        </>
      )}

      <Toasts />

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        onChange={onPick}
        className="sr-only"
        aria-hidden
        tabIndex={-1}
      />
    </div>
  );
}
