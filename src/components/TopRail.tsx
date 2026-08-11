import { useViewer } from '@/store/useViewer';
import { bytes, shortName } from '@/lib/format';
import { useIsCompact } from '@/hooks/useMediaQuery';
import { IconCamera, IconMoon, IconOpen, IconPanel, IconSun } from './Icons';
import logoUrl from '@/assets/logo.png';

export function TopRail({ onOpen, onScreenshot }: { onOpen: () => void; onScreenshot: () => void }) {
  const model = useViewer((s) => s.model);
  const theme = useViewer((s) => s.theme);
  const setTheme = useViewer((s) => s.setTheme);
  const togglePanel = useViewer((s) => s.togglePanel);
  const toggleSheet = useViewer((s) => s.toggleSheet);
  const panelOpen = useViewer((s) => s.panelOpen);
  const compact = useIsCompact();

  return (
    <header className="toprail area-top">
      {/* The name lives on the image, because the wordmark beside it is dropped
          on a narrow phone and the mark would otherwise go unannounced. */}
      <div className="mark">
        <img className="mark-logo" src={logoUrl} alt="Caliper" width={26} height={26} />
        <span className="mark-word" aria-hidden>
          Caliper
        </span>
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
        <button className="btn" data-variant="ghost-line" onClick={onOpen} title="Open a model  ⌘O">
          <IconOpen size={16} />
          {!compact && <span>Open</span>}
        </button>

        <button
          className="btn btn-icon"
          onClick={onScreenshot}
          disabled={!model}
          title="Save a PNG of this view  ⌘S"
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
          aria-pressed={compact ? undefined : panelOpen}
          onClick={() => (compact ? toggleSheet(true) : togglePanel())}
          title="Details  ⌘B"
        >
          <IconPanel size={17} />
          <span className="sr-only">Toggle the details panel</span>
        </button>
      </div>
    </header>
  );
}
