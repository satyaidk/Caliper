import type { ReactNode } from 'react';
import { useViewer } from '@/store/useViewer';
import type { RenderMode } from '@/types';
import { IconEdges, IconFit, IconGrid, IconShaded, IconShadow, IconWire } from './Icons';

interface ToolProps {
  label: string;
  keys?: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function Tool({ label, keys, active, onClick, children }: ToolProps) {
  return (
    <button className="tool" aria-pressed={active} aria-label={label} onClick={onClick}>
      {children}
      <span className="tip">
        {label}
        {keys && <kbd className="kbd">{keys}</kbd>}
      </span>
    </button>
  );
}

const MODES: { mode: RenderMode; label: string; keys: string; icon: ReactNode }[] = [
  { mode: 'shaded', label: 'Shade the surfaces', keys: 'Q', icon: <IconShaded /> },
  { mode: 'wireframe', label: 'Show the wireframe', keys: 'W', icon: <IconWire /> },
  { mode: 'edges', label: 'Shade with edges', keys: 'E', icon: <IconEdges /> },
];

/**
 * The rail is only about how the model looks. Measuring lives in the panel,
 * with room for a label — putting it in both places would be two doors to one
 * room, which is exactly the kind of thing that makes a viewer feel heavy.
 */
export function ToolButtons() {
  const display = useViewer((s) => s.display);
  const setDisplay = useViewer((s) => s.setDisplay);
  const frameAll = useViewer((s) => s.frameAll);

  return (
    <>
      {MODES.map((m) => (
        <Tool
          key={m.mode}
          label={m.label}
          keys={m.keys}
          active={display.renderMode === m.mode}
          onClick={() => setDisplay('renderMode', m.mode)}
        >
          {m.icon}
        </Tool>
      ))}

      <span className="tool-sep" />

      <Tool
        label={display.grid ? 'Hide the build plate' : 'Show the build plate'}
        keys="G"
        active={display.grid}
        onClick={() => setDisplay('grid', !display.grid)}
      >
        <IconGrid />
      </Tool>
      <Tool
        label={display.shadows ? 'Turn shadows off' : 'Turn shadows on'}
        keys="S"
        active={display.shadows}
        onClick={() => setDisplay('shadows', !display.shadows)}
      >
        <IconShadow />
      </Tool>

      <span className="tool-sep" />

      <Tool label="Fit the model to the screen" keys="F" onClick={frameAll}>
        <IconFit />
      </Tool>
    </>
  );
}

export function ToolRail() {
  return (
    <nav className="toolrail area-rail" aria-label="View tools">
      <ToolButtons />
    </nav>
  );
}
