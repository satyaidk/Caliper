import { useState, type FormEvent } from 'react';
import { specFor } from '@/lib/formats';
import { isMakerWorldUrl, modelNameFromUrl } from '@/lib/remote';
import { parseMakerWorldUrl } from '@/lib/makerworld';
import { ago, bytes } from '@/lib/format';
import { useViewer } from '@/store/useViewer';
import { useInstall, isStandalone } from '@/hooks/useInstall';
import {
  IconAdd,
  IconDownload,
  IconGear,
  IconKeyboard,
  IconLink,
  IconOpen,
  IconPreview,
  IconRecent,
  IconTrash,
} from './Icons';
import { Switch } from './ui';
import { MakerWorldChooser } from './MakerWorldChooser';

/**
 * Recently opened models, reopened from this device's storage without choosing
 * the file again. Clearing the browser's site data empties it, and the switch
 * turns it off — which also forgets everything already kept.
 */
function RecentModels() {
  const recent = useViewer((s) => s.recent);
  const keep = useViewer((s) => s.keepRecent);
  const setKeep = useViewer((s) => s.setKeepRecent);
  const openRecent = useViewer((s) => s.openRecent);
  const forget = useViewer((s) => s.forgetRecent);
  const clear = useViewer((s) => s.clearRecent);
  const onPlate = useViewer((s) => s.models.length);

  return (
    <section className="home-block" aria-labelledby="home-recent">
      <div className="home-h2-row">
        <h2 className="home-h2" id="home-recent">
          Recently opened
        </h2>
        {keep && recent.length > 0 && (
          <button type="button" className="link-btn" onClick={() => void clear()}>
            Forget all
          </button>
        )}
      </div>

      {keep && recent.length > 0 && (
        <ul className="recent">
          {recent.map((entry) => (
            <li key={entry.id} className="recent-card">
              <button
                type="button"
                className="recent-open"
                onClick={() => void openRecent(entry.id)}
                title={`Open ${entry.name}`}
              >
                <span className="recent-thumb" style={{ '--tint': entry.colour } as React.CSSProperties}>
                  {entry.thumb ? <img src={entry.thumb} alt="" /> : <span className="recent-ext">.{entry.ext}</span>}
                </span>
                <span className="recent-name">{entry.name}</span>
                <span className="recent-meta">
                  <span className="badge-fmt" data-kind={specFor(entry.name)?.pipeline}>
                    {entry.ext}
                  </span>
                  <span className="num">{bytes(entry.bytes)}</span>
                  <span>{ago(entry.openedAt)}</span>
                </span>
              </button>
              <div className="recent-actions">
                {onPlate > 0 && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => void openRecent(entry.id, 'add')}
                    aria-label={`Add ${entry.name} to the plate`}
                    title="Add to the plate"
                  >
                    <IconAdd size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void forget(entry.id)}
                  aria-label={`Forget ${entry.name}`}
                  title="Forget"
                >
                  <IconTrash size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {keep && !recent.length && (
        <p className="note">Models you open are kept here so you can come back to them without choosing the file again.</p>
      )}

      <Switch checked={keep} onChange={setKeep} label="Remember recently opened models on this device" />
      <p className="note">
        Kept in this browser’s storage, never uploaded. Clearing the browser’s site data empties the list; turning
        this off forgets everything at once.
      </p>
    </section>
  );
}

/**
 * Bambu Studio's Home tab: a column of ways in at the left, and the page
 * proper beside it. Where Bambu lists recent projects, Caliper lists recently
 * opened models — kept in this browser only, and only while the person lets
 * it — then what you can open and what you can do once it is open.
 */
export function Home({ onOpen }: { onOpen: () => void }) {
  const openSample = useViewer((s) => s.openSample);
  const openFromUrl = useViewer((s) => s.openFromUrl);
  const setShortcutsOpen = useViewer((s) => s.setShortcutsOpen);
  const model = useViewer((s) => s.model);
  const onPlate = useViewer((s) => s.models.length);
  const lastPlate = useViewer((s) => s.lastPlate);
  const restorePlate = useViewer((s) => s.restorePlate);
  const setWorkspace = useViewer((s) => s.setWorkspace);
  const { canInstall, install } = useInstall();
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [makerWorldTarget, setMakerWorldTarget] = useState<ReturnType<typeof parseMakerWorldUrl>>(null);

  const submitLink = (event: FormEvent) => {
    event.preventDefault();
    try {
      const url = new URL(link.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      if (isMakerWorldUrl(url.href)) {
        const target = parseMakerWorldUrl(url.href);
        if (!target) throw new Error('Paste a MakerWorld model page link, not a search or home page.');
        setMakerWorldTarget(target);
        setLinkError('');
        return;
      }
      setLinkError('');
      void openFromUrl(url.href, modelNameFromUrl(url.href));
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : 'That is not a valid web address.');
    }
  };

  return (
    <div className="home">
      <nav className="home-nav" aria-label="Start">
        <button type="button" className="home-action" data-primary onClick={onOpen}>
          <IconOpen />
          <span>Open a model</span>
        </button>
        <button type="button" className="home-action" onClick={() => void openSample()}>
          <IconGear />
          <span>Open the sample gear</span>
        </button>
        {model && (
          <button type="button" className="home-action" onClick={() => setWorkspace('prepare')}>
            <IconPreview />
            <span>{onPlate > 1 ? `Back to the plate (${onPlate} models)` : `Back to ${model.name}`}</span>
          </button>
        )}
        {!onPlate && lastPlate.length > 0 && (
          <button type="button" className="home-action" onClick={() => void restorePlate()}>
            <IconRecent />
            <span>
              Restore the last plate
              {lastPlate.length > 1 ? ` (${lastPlate.length} models)` : ''}
            </span>
          </button>
        )}

        <form className="home-link" onSubmit={submitLink}>
          <label htmlFor="home-link-input">
            <IconLink />
            Open from a link
          </label>
          <div className="home-link-row">
            <input
              id="home-link-input"
              type="url"
              inputMode="url"
              placeholder="https://…/part.stl"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              aria-invalid={Boolean(linkError)}
              aria-describedby={linkError ? 'home-link-error' : undefined}
            />
            <button type="submit" className="btn" data-variant="ghost" disabled={!link.trim()}>
              Open
            </button>
          </div>
          {linkError && (
            <p className="field-error" id="home-link-error">
              {linkError}
            </p>
          )}
        </form>

        <div className="home-nav-foot">
          {canInstall && !isStandalone() && (
            <button type="button" className="home-action" onClick={() => void install()}>
              <IconDownload />
              <span>Install as an app</span>
            </button>
          )}
          <button type="button" className="home-action" onClick={() => setShortcutsOpen(true)}>
            <IconKeyboard />
            <span>Keyboard shortcuts</span>
          </button>
        </div>
      </nav>

      <div className="home-main">
        <header className="home-head">
          <h1 className="home-title">Slice a model for your Bambu Lab P1S</h1>
          <p className="home-lede">Open a model, pick a filament and quality, then download a file the printer reads from its microSD card. Files never leave this device.</p>
        </header>

        <button type="button" className="dropzone" onClick={onOpen}>
          <IconOpen size={26} />
          <span className="dropzone-title">Drop a model here</span>
          <span className="dropzone-sub">or click to choose. STL, 3MF, STEP, OBJ and more.</span>
        </button>

        <RecentModels />

      </div>
      {makerWorldTarget && <MakerWorldChooser target={makerWorldTarget} onClose={() => setMakerWorldTarget(null)} />}
    </div>
  );
}
