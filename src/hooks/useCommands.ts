import { useEffect, useMemo } from 'react';
import { useViewer } from '@/store/useViewer';
import { bytes } from '@/lib/format';
import type { RenderMode, ViewPreset } from '@/types';

export interface Command {
  id: string;
  group: 'File' | 'View' | 'Display' | 'Selection' | 'Export';
  name: string;
  /** Single key, or a `mod+` prefixed combination. */
  keys?: string;
  disabled?: boolean;
  run: () => void;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Commands read live state through `getState()` at the moment they run, so this
 * hook only subscribes to the slices that change a label or grey an entry out.
 * Subscribing to the whole store would re-render the app on every frame sample.
 */
export function useCommands(openPicker: () => void): Command[] {
  const engine = useViewer((s) => s.engine);
  const model = useViewer((s) => s.model);
  const display = useViewer((s) => s.display);
  const theme = useViewer((s) => s.theme);
  const inspectorOpen = useViewer((s) => s.inspectorOpen);
  const selection = useViewer((s) => s.selection);
  const ready = Boolean(model);

  return useMemo<Command[]>(() => {
    const store = useViewer.getState();
    const view = (name: string, preset: ViewPreset, keys: string): Command => ({
      id: `view.${preset}`,
      group: 'View',
      name,
      keys,
      run: () => store.setView(preset),
    });

    const mode = (name: string, value: RenderMode, keys: string): Command => ({
      id: `display.${value}`,
      group: 'Display',
      name,
      keys,
      run: () => store.setDisplay('renderMode', value),
    });

    const stem = model?.name.replace(/\.[^.]+$/, '') ?? 'model';

    return [
      {
        id: 'file.open',
        group: 'File',
        name: 'Open a model…',
        keys: 'mod+o',
        run: openPicker,
      },
      {
        id: 'file.close',
        group: 'File',
        name: 'Close the model',
        disabled: !ready,
        run: () => store.close(),
      },

      view('Look at the front', 'front', '1'),
      view('Look at the back', 'back', '2'),
      view('Look from the left', 'left', '3'),
      view('Look from the right', 'right', '4'),
      view('Look from the top', 'top', '5'),
      view('Look from below', 'bottom', '6'),
      view('Return to the isometric view', 'iso', '0'),
      { id: 'view.fit', group: 'View', name: 'Fit the model to the screen', keys: 'f', run: () => store.frameAll() },
      {
        id: 'view.projection',
        group: 'View',
        name:
          display.projection === 'perspective'
            ? 'Switch to orthographic projection'
            : 'Switch to perspective projection',
        keys: 'p',
        run: () =>
          store.setDisplay('projection', display.projection === 'perspective' ? 'orthographic' : 'perspective'),
      },
      {
        id: 'view.spin',
        group: 'View',
        name: display.autoRotate ? 'Stop the turntable' : 'Start the turntable',
        keys: 'r',
        run: () => store.setDisplay('autoRotate', !display.autoRotate),
      },

      mode('Shade the surfaces', 'shaded', 'q'),
      mode('Show the wireframe', 'wireframe', 'w'),
      mode('Shade with edges', 'edges', 'e'),
      mode('Show an x-ray view', 'xray', 'x'),
      mode('Colour by surface normal', 'normals', 'n'),
      {
        id: 'display.grid',
        group: 'Display',
        name: display.grid ? 'Hide the grid' : 'Show the grid',
        keys: 'g',
        run: () => store.setDisplay('grid', !display.grid),
      },
      {
        id: 'display.axes',
        group: 'Display',
        name: display.axes ? 'Hide the axes' : 'Show the axes',
        keys: 'a',
        run: () => store.setDisplay('axes', !display.axes),
      },
      {
        id: 'display.shadows',
        group: 'Display',
        name: display.shadows ? 'Turn shadows off' : 'Turn shadows on',
        keys: 's',
        run: () => store.setDisplay('shadows', !display.shadows),
      },
      {
        id: 'display.clip',
        group: 'Display',
        name: display.clipEnabled ? 'Remove the section plane' : 'Cut a section',
        keys: 'c',
        disabled: !ready,
        run: () => store.setDisplay('clipEnabled', !display.clipEnabled),
      },
      {
        id: 'display.theme',
        group: 'Display',
        name: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
        keys: 'mod+j',
        run: () => store.setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'display.inspector',
        group: 'Display',
        name: inspectorOpen ? 'Hide the inspector' : 'Show the inspector',
        keys: 'mod+b',
        run: () => store.toggleInspector(),
      },

      {
        id: 'selection.clear',
        group: 'Selection',
        name: 'Clear the selection',
        keys: 'escape',
        disabled: !selection,
        run: () => store.selectNode(null),
      },
      {
        id: 'selection.isolate',
        group: 'Selection',
        name: 'Isolate the selected part',
        keys: 'i',
        disabled: !selection,
        run: () => {
          if (selection) engine?.isolate(selection.id);
        },
      },
      {
        id: 'selection.showall',
        group: 'Selection',
        name: 'Show every part again',
        keys: 'shift+i',
        disabled: !ready,
        run: () => store.showAll(),
      },

      {
        id: 'export.png',
        group: 'Export',
        name: 'Save a PNG of this view',
        keys: 'mod+s',
        disabled: !ready,
        run: () => {
          if (!engine) return;
          const a = document.createElement('a');
          a.href = engine.screenshot(2);
          a.download = `${stem}.png`;
          a.click();
          store.toast({ tone: 'success', title: 'Saved the view as PNG' });
        },
      },
      {
        id: 'export.glb',
        group: 'Export',
        name: 'Export the model as glTF binary',
        disabled: !ready,
        run: async () => {
          if (!engine) return;
          try {
            const blob = await engine.exportGLB();
            download(blob, `${stem}.glb`);
            store.toast({ tone: 'success', title: 'Exported GLB', text: bytes(blob.size) });
          } catch (error) {
            store.toast({
              tone: 'error',
              title: 'Export failed',
              text: error instanceof Error ? error.message : undefined,
            });
          }
        },
      },
      {
        id: 'export.stl',
        group: 'Export',
        name: 'Export the model as STL',
        disabled: !ready,
        run: () => {
          if (!engine) return;
          try {
            const blob = engine.exportSTL();
            download(blob, `${stem}.stl`);
            store.toast({ tone: 'success', title: 'Exported STL', text: bytes(blob.size) });
          } catch (error) {
            store.toast({
              tone: 'error',
              title: 'Export failed',
              text: error instanceof Error ? error.message : undefined,
            });
          }
        },
      },
    ];
  }, [engine, model, display, theme, inspectorOpen, selection, ready, openPicker]);
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function useHotkeys(commands: Command[]) {
  const togglePalette = useViewer((s) => s.togglePalette);
  const paletteOpen = useViewer((s) => s.paletteOpen);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (EDITABLE.has(target.tagName) || target.isContentEditable)) return;

      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && key === 'k') {
        event.preventDefault();
        togglePalette();
        return;
      }
      if (paletteOpen) return;

      const combo = `${mod ? 'mod+' : ''}${event.shiftKey && key.length === 1 ? 'shift+' : ''}${key}`;
      const command = commands.find((c) => c.keys === combo && !c.disabled);
      if (!command) return;
      event.preventDefault();
      command.run();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commands, togglePalette, paletteOpen]);
}
