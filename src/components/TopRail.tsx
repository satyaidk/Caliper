import { useViewer } from '@/store/useViewer';
import { bytes, shortName } from '@/lib/format';
import { useIsCompact } from '@/hooks/useMediaQuery';
import {
  IconCamera,
  IconCube,
  IconMoon,
  IconOpen,
  IconPanel,
  IconSearch,
  IconSun,
} from './Icons';

export function TopRail({ onOpen }: { onOpen: () => void }) {
  const model = useViewer((s) => s.model);
  const theme = useViewer((s) => s.theme);
  const setTheme = useViewer((s) => s.setTheme);
  const togglePalette = useViewer((s) => s.togglePalette);
  const toggleInspector = useViewer((s) => s.toggleInspector);
  const toggleSheet = useViewer((s) => s.toggleSheet);
  const inspectorOpen = useViewer((s) => s.inspectorOpen);
  const engine = useViewer((s) => s.engine);
  const toast = useViewer((s) => s.toast);
  const compact = useIsCompact();

  const capture = () => {
    if (!engine || !model) return;
    const a = document.createElement('a');
    a.href = engine.screenshot(2);
    a.download = `${model.name.replace(/\.[^.]+$/, '')}.png`;
    a.click();
    toast({ tone: 'success', title: 'Saved the view as PNG' });
  };

  return (
    <header className="toprail area-top">
      <div className="mark">
        <IconCube />
        <span className="mark-word">Caliper</span>
      </div>

      <div className="filecrumb">
        {model ? (
          <>
            <span className="badge-fmt" data-kind={model.pipeline}>
              {model.ext}
            </span>
            <span className="filecrumb-name" title={model.name}>
              {shortName(model.name, compact ? 20 : 46)}
            </span>
            {!compact && <span className="filecrumb-meta mono">{bytes(model.bytes)}</span>}
          </>
        ) : (
          <span className="filecrumb-meta">No model open</span>
        )}
      </div>

      <div className="rail-actions">
        <button className="btn" data-variant="ghost-line" onClick={onOpen}>
          <IconOpen size={16} />
          {!compact && <span>Open</span>}
        </button>

        {!compact && (
          <button className="btn btn-icon" onClick={() => togglePalette(true)} title="Commands  ⌘K">
            <IconSearch />
            <span className="sr-only">Open the command palette</span>
          </button>
        )}

        <button
          className="btn btn-icon"
          onClick={capture}
          disabled={!model}
          title="Save a PNG of this view"
        >
          <IconCamera size={17} />
          <span className="sr-only">Save a PNG of this view</span>
        </button>

        <button
          className="btn btn-icon"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
        >
          {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
          <span className="sr-only">Switch theme</span>
        </button>

        <button
          className="btn btn-icon"
          aria-pressed={compact ? undefined : inspectorOpen}
          onClick={() => (compact ? toggleSheet(true) : toggleInspector())}
          title="Inspector"
        >
          <IconPanel size={17} />
          <span className="sr-only">Toggle the inspector</span>
        </button>
      </div>
    </header>
  );
}
