import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewer } from '@/store/useViewer';
import { bytes } from '@/lib/format';
import { extOf, specFor } from '@/lib/formats';
import { pathOf } from '@/lib/archive';
import { MAX_MODELS } from '@/lib/intake';
import { IconArchive, IconClose, IconSearch } from './Icons';

/**
 * "Which of these do you want to see?" — asked when a zip holds more than one
 * model, or a drop holds more than a handful.
 *
 * Every model in the collection is listed with its folder, format and size.
 * One is ticked to start with so Enter opens something straight away; Select
 * all puts the whole collection on the plate side by side. Large collections
 * get a filter, because finding `bracket-v3.step` in a list of two hundred is
 * the whole job of this dialog.
 */
export function ModelChooser() {
  const pick = useViewer((s) => s.pick);
  const onPlate = useViewer((s) => s.models.length);
  const openPicked = useViewer((s) => s.openPicked);
  const cancel = useViewer((s) => s.cancelPick);
  const dialog = useRef<HTMLDialogElement>(null);
  const [chosen, setChosen] = useState<Set<File>>(new Set());
  const [query, setQuery] = useState('');

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (pick && !node.open) {
      setChosen(new Set(pick.models.slice(0, 1)));
      setQuery('');
      node.showModal();
    }
    if (!pick && node.open) node.close();
  }, [pick]);

  const shown = useMemo(() => {
    if (!pick) return [];
    const needle = query.trim().toLowerCase();
    return needle ? pick.models.filter((f) => pathOf(f).toLowerCase().includes(needle)) : pick.models;
  }, [pick, query]);

  if (!pick) return <dialog ref={dialog} className="dialog" aria-label="Choose models" />;

  const room = pick.mode === 'add' ? Math.max(0, MAX_MODELS - onPlate) : MAX_MODELS;
  const over = chosen.size > room;
  const allShown = shown.length > 0 && shown.every((f) => chosen.has(f));

  const toggle = (file: File) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  const setShown = (on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      shown.forEach((f) => (on ? next.add(f) : next.delete(f)));
      return next;
    });

  // Opened in the order the list shows them, so the first ticked is the one described.
  const confirm = () => void openPicked(pick.models.filter((f) => chosen.has(f)).slice(0, room));

  return (
    <dialog
      ref={dialog}
      className="dialog chooser"
      aria-labelledby="chooser-title"
      onClose={cancel}
      onClick={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <header className="dialog-head">
        <h2 id="chooser-title">
          <IconArchive size={18} />
          <span>
            {pick.models.length} models in <b title={pick.source}>{pick.source}</b>
          </span>
        </h2>
        <button type="button" className="icon-btn" onClick={cancel} aria-label="Close">
          <IconClose />
        </button>
      </header>

      <form
        className="chooser-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen.size) confirm();
        }}
      >
        <div className="chooser-tools">
          {pick.models.length > 8 && (
            <label className="search">
              <IconSearch />
              <input
                type="search"
                placeholder={`Filter ${pick.models.length} models`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Filter models by name"
              />
            </label>
          )}
          <button type="button" className="btn" data-variant="ghost" onClick={() => setShown(!allShown)}>
            {allShown ? 'Select none' : query ? 'Select these' : 'Select all'}
          </button>
        </div>

        <ul className="chooser-list" aria-label="Models">
          {shown.map((file) => {
            const path = pathOf(file);
            const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            const spec = specFor(file.name);
            return (
              <li key={path}>
                <label className="chooser-row" data-on={chosen.has(file)}>
                  <input type="checkbox" checked={chosen.has(file)} onChange={() => toggle(file)} />
                  <span className="badge-fmt" data-kind={spec?.pipeline}>
                    {extOf(file.name)}
                  </span>
                  <span className="chooser-name">
                    <span>{file.name}</span>
                    {folder && <small>{folder}</small>}
                  </span>
                  <span className="chooser-size num">{bytes(file.size)}</span>
                </label>
              </li>
            );
          })}
          {!shown.length && <li className="hint">No model name contains “{query}”.</li>}
        </ul>

        <footer className="chooser-foot">
          <p className="hint" data-tone={over ? 'warn' : undefined}>
            {over
              ? `Only ${room} more fit on the plate; the first ${room} ticked will open.`
              : pick.mode === 'add' && onPlate
                ? 'They join the models already on the plate.'
                : pick.companions.length
                  ? `Textures and materials in the archive come along (${pick.companions.length}).`
                  : 'Each model gets its own colour and can be moved on the plate.'}
          </p>
          <div className="row-actions">
            <button type="button" className="btn" data-variant="ghost" onClick={cancel}>
              Cancel
            </button>
            <button type="submit" className="btn" data-variant="primary" disabled={!chosen.size}>
              {chosen.size > 1 ? `Open ${Math.min(chosen.size, room)} models` : 'Open model'}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
