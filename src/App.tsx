import { useCallback, useEffect, useRef } from 'react';
import { useViewer } from '@/store/useViewer';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useCommands, useHotkeys } from '@/hooks/useCommands';
import { useIsCompact } from '@/hooks/useMediaQuery';
import { ACCEPT } from '@/lib/formats';
import { TopRail } from '@/components/TopRail';
import { ToolRail } from '@/components/ToolRail';
import { Viewport } from '@/components/Viewport';
import { Inspector } from '@/components/Inspector';
import { StatusStrip } from '@/components/StatusStrip';
import { CommandPalette } from '@/components/CommandPalette';
import { Toasts } from '@/components/Toasts';

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const open = useViewer((s) => s.open);
  const inspectorOpen = useViewer((s) => s.inspectorOpen);
  const sheetOpen = useViewer((s) => s.sheetOpen);
  const toggleSheet = useViewer((s) => s.toggleSheet);
  const theme = useViewer((s) => s.theme);
  const compact = useIsCompact();

  const openPicker = useCallback(() => inputRef.current?.click(), []);
  const dragging = useFileDrop((files) => void open(files));
  const commands = useCommands(openPicker);
  useHotkeys(commands);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Opening the same file twice in a row should still reload it.
  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length) void open(files);
    event.target.value = '';
  };

  return (
    <div className="shell" data-inspector={inspectorOpen && !compact ? 'open' : 'closed'}>
      <TopRail onOpen={openPicker} />
      {!compact && <ToolRail />}

      <main className="area-stage">
        <Viewport dragging={dragging} onOpen={openPicker} />
      </main>

      {!compact && inspectorOpen && (
        <div className="area-inspector">
          <Inspector />
        </div>
      )}

      {!compact && <StatusStrip />}

      {compact && sheetOpen && (
        <>
          <div className="sheet-scrim" onClick={() => toggleSheet(false)} />
          <div className="sheet" role="dialog" aria-label="Inspector">
            <div className="sheet-grab" />
            <Inspector />
          </div>
        </>
      )}

      <CommandPalette commands={commands} />
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
