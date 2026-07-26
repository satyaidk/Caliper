import type { ReactNode } from 'react';
import { useViewer } from '@/store/useViewer';
import type { RenderMode } from '@/types';
import {
  IconAxes,
  IconEdges,
  IconExplode,
  IconFit,
  IconGrid,
  IconNormals,
  IconSection,
  IconShaded,
  IconSpin,
  IconWire,
  IconXray,
} from './Icons';

interface ToolProps {
  label: string;
  keys?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function Tool({ label, keys, active, disabled, onClick, children }: ToolProps) {
  return (
    <button
      className="tool"
      aria-pressed={active}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
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
  { mode: 'xray', label: 'Show an x-ray view', keys: 'X', icon: <IconXray /> },
  { mode: 'normals', label: 'Colour by surface normal', keys: 'N', icon: <IconNormals /> },
];

/** Shared by the desktop rail and the mobile dock. */
export function ToolButtons({ compact }: { compact?: boolean }) {
  const display = useViewer((s) => s.display);
  const setDisplay = useViewer((s) => s.setDisplay);
  const frameAll = useViewer((s) => s.frameAll);
  const setTab = useViewer((s) => s.setTab);
  const toggleSheet = useViewer((s) => s.toggleSheet);
  const toggleInspector = useViewer((s) => s.toggleInspector);
  const ready = useViewer((s) => s.status === 'ready');

  const goToDisplayTab = () => {
    setTab('display');
    if (compact) toggleSheet(true);
    else toggleInspector(true);
  };

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
        label={display.grid ? 'Hide the grid' : 'Show the grid'}
        keys="G"
        active={display.grid}
        onClick={() => setDisplay('grid', !display.grid)}
      >
        <IconGrid />
      </Tool>
      <Tool
        label={display.axes ? 'Hide the axes' : 'Show the axes'}
        keys="A"
        active={display.axes}
        onClick={() => setDisplay('axes', !display.axes)}
      >
        <IconAxes />
      </Tool>

      <span className="tool-sep" />

      <Tool
        label={display.clipEnabled ? 'Remove the section plane' : 'Cut a section'}
        keys="C"
        active={display.clipEnabled}
        disabled={!ready}
        onClick={() => {
          setDisplay('clipEnabled', !display.clipEnabled);
          if (!display.clipEnabled) goToDisplayTab();
        }}
      >
        <IconSection />
      </Tool>
      <Tool
        label="Pull the parts apart"
        active={display.explode > 0}
        disabled={!ready}
        onClick={goToDisplayTab}
      >
        <IconExplode />
      </Tool>
      <Tool
        label={display.autoRotate ? 'Stop the turntable' : 'Start the turntable'}
        keys="R"
        active={display.autoRotate}
        onClick={() => setDisplay('autoRotate', !display.autoRotate)}
      >
        <IconSpin />
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
    <nav className="toolrail area-rail" aria-label="Viewer tools">
      <ToolButtons />
    </nav>
  );
}
