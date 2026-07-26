import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewer } from '@/store/useViewer';
import type { Command } from '@/hooks/useCommands';
import { IconSearch } from './Icons';

/** Subsequence match: "swi" finds "Switch to the light theme". */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct === 0) return 1000;
  if (direct > 0) return 700 - direct;

  let i = 0;
  let hits = 0;
  let streak = 0;
  let best = 0;
  for (const char of t) {
    if (char === q[i]) {
      i++;
      hits++;
      streak++;
      best = Math.max(best, streak);
    } else {
      streak = 0;
    }
    if (i >= q.length) break;
  }
  return i >= q.length ? 100 + hits * 4 + best * 6 : -1;
}

function prettyKeys(keys: string): string {
  const isApple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return keys
    .split('+')
    .map((k) => {
      if (k === 'mod') return isApple ? '⌘' : 'Ctrl';
      if (k === 'shift') return '⇧';
      if (k === 'escape') return 'Esc';
      return k.toUpperCase();
    })
    .join(isApple ? '' : '+');
}

export function CommandPalette({ commands }: { commands: Command[] }) {
  const open = useViewer((s) => s.paletteOpen);
  const togglePalette = useViewer((s) => s.togglePalette);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    return commands
      .filter((c) => !c.disabled)
      .map((c) => ({ command: c, s: score(query, `${c.group} ${c.name}`) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.command);
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (command: Command) => {
    togglePalette(false);
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      togglePalette(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault();
      run(results[active]);
    }
  };

  return (
    <div
      className="palette-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Commands"
      onMouseDown={(e) => e.target === e.currentTarget && togglePalette(false)}
    >
      <div className="palette" onKeyDown={onKeyDown}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 14 }}>
          <IconSearch />
          <input
            ref={inputRef}
            className="palette-input"
            style={{ paddingLeft: 0 }}
            placeholder="Search commands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search commands"
          />
        </div>

        <div className="palette-list" ref={listRef}>
          {results.length === 0 ? (
            <p className="palette-empty">Nothing matches “{query}”.</p>
          ) : (
            results.map((command, i) => (
              <button
                key={command.id}
                className="palette-item"
                data-active={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(command)}
              >
                <span className="eyebrow" style={{ width: 62, flex: 'none' }}>
                  {command.group}
                </span>
                <span className="palette-item-name">{command.name}</span>
                {command.keys && <kbd className="kbd">{prettyKeys(command.keys)}</kbd>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
