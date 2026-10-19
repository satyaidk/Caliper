import { useState, type FormEvent } from 'react';
import { BY_PIPELINE, FORMATS, PIPELINE_COPY, baseOf, specFor } from '@/lib/formats';
import { ago, bytes } from '@/lib/format';
import { useViewer } from '@/store/useViewer';
import { useInstall, isStandalone } from '@/hooks/useInstall';
import type { Pipeline } from '@/types';
import {
  IconAdd,
  IconAngle,
  IconArrange,
  IconAutoOrient,
  IconDiameter,
  IconDistance,
  IconDownload,
  IconExplode,
  IconGear,
  IconKeyboard,
  IconLayFace,
  IconLink,
  IconMove,
  IconOpen,
  IconOverhang,
  IconPreview,
  IconRecent,
  IconSection,
  IconTrash,
} from './Icons';
import { Switch } from './ui';

const ORDER: Pipeline[] = ['mesh', 'cad', 'bim'];

/** The tools, as the toolbar shows them, so the start page doubles as a key. */
const TOOLS = [
  { icon: <IconAutoOrient />, name: 'Auto orient', text: 'Stands the part on its largest flat face.', keys: 'R' },
  { icon: <IconLayFace />, name: 'Lay on face', text: 'Click a face and it goes down onto the plate.', keys: 'F' },
  { icon: <IconDistance />, name: 'Distance', text: 'Two points, with the span split into X, Y and Z.', keys: 'U' },
  { icon: <IconDiameter />, name: 'Diameter', text: 'Three points on a hole fit a circle through it.', keys: 'D' },
  { icon: <IconAngle />, name: 'Angle', text: 'An arm, the corner, the other arm.', keys: 'A' },
  { icon: <IconSection />, name: 'Section view', text: 'Cut the part along X, Y or Z and see a solid face.', keys: 'X' },
  { icon: <IconExplode />, name: 'Assembly view', text: 'Pull the parts of an assembly apart.', keys: 'Y' },
  { icon: <IconOverhang />, name: 'Overhangs', text: 'Faces that would print in mid-air turn red.', keys: 'O' },
  { icon: <IconMove />, name: 'Move', text: 'Drag models across the plate to lay them out.', keys: 'M' },
  { icon: <IconArrange />, name: 'Arrange', text: 'Pack every model on the plate side by side.', keys: 'T' },
  { icon: <IconPreview />, name: 'Preview', text: 'Step through the part layer by layer from the plate up.', keys: '' },
];

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

  const submitLink = (event: FormEvent) => {
    event.preventDefault();
    try {
      const url = new URL(link.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      setLinkError('');
      void openFromUrl(url.href, baseOf(decodeURIComponent(url.pathname)) || 'model');
    } catch {
      setLinkError('That is not a web address. It should start with https://');
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
          <h1 className="home-title">Open a 3D model and measure it</h1>
          <p className="home-lede">
            Drop a file anywhere in this window. It is read on this device and never uploaded, so it is safe for
            confidential parts, and once Caliper has loaded it keeps working without a connection.
          </p>
        </header>

        <button type="button" className="dropzone" onClick={onOpen}>
          <IconOpen size={26} />
          <span className="dropzone-title">Drop files, a folder or a .zip here</span>
          <span className="dropzone-sub">
            or click to choose. Several models open side by side on one plate; a .zip asks which of its models to
            show. An OBJ with its .mtl or a glTF with its textures can come as one folder or archive.
          </span>
        </button>

        <RecentModels />

        <section className="home-block" aria-labelledby="home-formats">
          <h2 className="home-h2" id="home-formats">
            {FORMATS.length} file types, three ways in
          </h2>
          <div className="formats">
            {ORDER.map((pipeline) => (
              <div className="formats-row" key={pipeline} data-kind={pipeline}>
                <div className="formats-label">
                  <b>{PIPELINE_COPY[pipeline].title}</b>
                  <span>{PIPELINE_COPY[pipeline].note}</span>
                </div>
                <ul className="chips">
                  {BY_PIPELINE[pipeline].map((spec) => (
                    <li className="chip" key={spec.ext} title={spec.label}>
                      .{spec.ext}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="note">
            STEP, IGES, BREP, FCStd, 3DM and IFC open through WebAssembly geometry kernels that download the first
            time one of those files is opened.
          </p>
        </section>

        <section className="home-block" aria-labelledby="home-tools">
          <h2 className="home-h2" id="home-tools">
            What you can do once it is open
          </h2>
          <ul className="toolkey">
            {TOOLS.map((tool) => (
              <li key={tool.name}>
                <span className="toolkey-icon">{tool.icon}</span>
                <span className="toolkey-text">
                  <b>{tool.name}</b>
                  {tool.text}
                </span>
                {tool.keys && <kbd className="kbd">{tool.keys}</kbd>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
