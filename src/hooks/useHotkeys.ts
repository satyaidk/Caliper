import { useEffect } from 'react';
import { useViewer } from '@/store/useViewer';
import type { RenderMode, ViewPreset } from '@/types';

/**
 * The whole keyboard, in one table.
 *
 * There is no command palette behind this and no separate command registry —
 * with this few actions, a second way to reach them is a second thing to learn.
 * Every key here is also a button you can see, and the buttons carry the same
 * letters in their tooltips.
 */

const VIEWS: Record<string, ViewPreset> = {
  '1': 'front',
  '2': 'back',
  '3': 'left',
  '4': 'right',
  '5': 'top',
  '6': 'bottom',
  '0': 'iso',
};

const MODES: Record<string, RenderMode> = {
  q: 'shaded',
  w: 'wireframe',
  e: 'edges',
};

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function useHotkeys(actions: { open: () => void; screenshot: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (EDITABLE.has(target.tagName) || target.isContentEditable)) return;

      const store = useViewer.getState();
      const key = event.key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;

      // Space and Enter already belong to whatever control has focus.
      if ((key === ' ' || key === 'enter') && target?.tagName === 'BUTTON') return;

      const run = (fn: () => void) => {
        event.preventDefault();
        fn();
      };

      if (mod) {
        if (key === 'o') return run(actions.open);
        if (key === 's') return run(actions.screenshot);
        if (key === 'b') return run(() => store.togglePanel());
        if (key === 'j') return run(() => store.setTheme(store.theme === 'dark' ? 'light' : 'dark'));
        return;
      }

      if (VIEWS[key]) return run(() => store.setView(VIEWS[key]));
      if (MODES[key]) return run(() => store.setDisplay('renderMode', MODES[key]));

      switch (key) {
        case 'f':
          return run(() => store.frameAll());
        case 'g':
          return run(() => store.setDisplay('grid', !store.display.grid));
        case 's':
          return run(() => store.setDisplay('shadows', !store.display.shadows));
        case 'm':
          return run(() => store.setMeasureTool('distance'));
        case 'd':
          return run(() => store.setMeasureTool('diameter'));
        case 'backspace':
          return run(() => store.undoMeasure());
        case 'escape':
          // One key, two jobs, in the order a person expects them: put the tool
          // away first, and only then let go of what is selected.
          if (store.measureTool !== 'off') return run(() => store.setMeasureTool('off'));
          if (store.selection) return run(() => store.clearSelection());
          return;
        default:
          return;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions]);
}
