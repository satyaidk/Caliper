import { useState } from 'react';
import { useViewer, type InspectorTab } from '@/store/useViewer';
import { bytes, count, dim, ms } from '@/lib/format';
import { PIPELINE_COPY } from '@/lib/formats';
import type { ClipAxis, TreeNode, UnitSystem } from '@/types';
import { IconChevron, IconEye, IconEyeOff } from './Icons';

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'model', label: 'Model' },
  { id: 'tree', label: 'Tree' },
  { id: 'display', label: 'Display' },
];

const UNITS: UnitSystem[] = ['mm', 'cm', 'm', 'in'];

const TINTS = ['#b8c3d4', '#e8e2d4', '#5a9cf8', '#7fd48c', '#f2695f', '#c8a2ff', '#2c313a'];

/* ------------------------------------------------------------- primitives */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{value}</span>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <button
        className="switch"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div style={disabled ? { opacity: 0.45 } : undefined}>
      <div className="field">
        <span className="field-label">{label}</span>
        <span className="field-value">{format(value)}</span>
      </div>
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/* ------------------------------------------------------------- model tab */

function DimensionRow({
  axis,
  value,
  longest,
  unit,
}: {
  axis: 'x' | 'y' | 'z';
  value: number;
  longest: number;
  unit: UnitSystem;
}) {
  return (
    <div className="dim" data-axis={axis}>
      <span className="dim-axis">{axis.toUpperCase()}</span>
      <span className="dim-bar">
        <i style={{ width: `${longest > 0 ? (value / longest) * 100 : 0}%` }} />
      </span>
      <span className="dim-val">{dim(value, unit)}</span>
    </div>
  );
}

function ModelTab() {
  const model = useViewer((s) => s.model);
  const selection = useViewer((s) => s.selection);
  const unit = useViewer((s) => s.unit);
  const setUnit = useViewer((s) => s.setUnit);

  if (!model) {
    return <p className="hint">Open a model and its measurements land here.</p>;
  }

  const d = model.dimensions;
  const longest = Math.max(d.x, d.y, d.z);

  return (
    <>
      <section className="group">
        <div className="group-title">
          <span className="eyebrow">Bounding box</span>
          <select
            className="select"
            style={{ minWidth: 66 }}
            value={unit}
            aria-label="Display units"
            onChange={(e) => setUnit(e.target.value as UnitSystem)}
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <DimensionRow axis="x" value={d.x} longest={longest} unit={unit} />
        <DimensionRow axis="y" value={d.y} longest={longest} unit={unit} />
        <DimensionRow axis="z" value={d.z} longest={longest} unit={unit} />
        <div style={{ marginTop: 8 }}>
          <Field label="Diagonal" value={dim(d.diagonal, unit)} />
        </div>
        <p className="matrix-foot" style={{ padding: '8px 0 0', border: 0 }}>
          Most formats carry no unit. Caliper reads the file's numbers as {unit} — switch above if
          the source used something else.
        </p>
      </section>

      <section className="group">
        <div className="group-title">
          <span className="eyebrow">Geometry</span>
        </div>
        <Field label="Triangles" value={count(model.stats.triangles)} />
        <Field label="Vertices" value={count(model.stats.vertices)} />
        <Field label="Parts" value={count(model.stats.meshes)} />
        <Field label="Materials" value={count(model.stats.materials)} />
        <Field label="Textures" value={count(model.stats.textures)} />
      </section>

      <section className="group">
        <div className="group-title">
          <span className="eyebrow">File</span>
        </div>
        <Field label="Format" value={model.ext.toUpperCase()} />
        <Field label="Pipeline" value={PIPELINE_COPY[model.pipeline].title} />
        <Field label="Size on disk" value={bytes(model.bytes)} />
        <Field label="Time to open" value={ms(model.parseMs)} />
      </section>

      {selection && (
        <section className="group">
          <div className="group-title">
            <span className="eyebrow">Selected part</span>
          </div>
          <Field label="Name" value={selection.name} />
          <Field label="Kind" value={selection.type} />
          <Field label="Triangles" value={count(selection.triangles)} />
          <Field label="Vertices" value={count(selection.vertices)} />
          <Field label="Material" value={selection.material} />
        </section>
      )}
    </>
  );
}

/* -------------------------------------------------------------- tree tab */

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const selection = useViewer((s) => s.selection);
  const hidden = useViewer((s) => s.hidden);
  const selectNode = useViewer((s) => s.selectNode);
  const toggleNode = useViewer((s) => s.toggleNode);

  const id = Number(node.id);
  const isHidden = hidden.includes(id);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div
        className="node"
        data-selected={selection?.id === id}
        data-hidden={isHidden}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span className="node-twist">
          {hasChildren && (
            <button
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? 'Collapse' : 'Expand'}
              aria-expanded={open}
              style={{
                display: 'grid',
                placeItems: 'center',
                rotate: open ? '90deg' : '0deg',
                transition: 'rotate 140ms var(--ease)',
                color: 'inherit',
              }}
            >
              <IconChevron />
            </button>
          )}
        </span>

        <button
          className="node-name"
          style={{ textAlign: 'left', color: 'inherit' }}
          onClick={() => selectNode(id)}
          title={node.name}
        >
          {node.name}
        </button>

        {node.triangles > 0 && <span className="node-count">{count(node.triangles)}</span>}

        <button
          className="node-eye"
          data-on={!isHidden}
          onClick={() => toggleNode(id)}
          aria-label={isHidden ? `Show ${node.name}` : `Hide ${node.name}`}
        >
          {isHidden ? <IconEyeOff /> : <IconEye />}
        </button>
      </div>

      {open && node.children.map((child) => <TreeRow key={child.id} node={child} depth={depth + 1} />)}
    </>
  );
}

function TreeTab() {
  const tree = useViewer((s) => s.tree);
  const hidden = useViewer((s) => s.hidden);
  const showAll = useViewer((s) => s.showAll);

  if (!tree) return <p className="hint">The scene tree appears once a model is open.</p>;

  return (
    <div className="tree">
      {hidden.length > 0 && (
        <div style={{ padding: '4px 8px 8px' }}>
          <button className="btn" data-variant="ghost-line" style={{ width: '100%' }} onClick={showAll}>
            Show {hidden.length} hidden {hidden.length === 1 ? 'part' : 'parts'}
          </button>
        </div>
      )}
      <TreeRow node={tree} depth={0} />
    </div>
  );
}

/* ----------------------------------------------------------- display tab */

const CLIP_AXES: ClipAxis[] = ['x', 'y', 'z'];

function DisplayTab() {
  const display = useViewer((s) => s.display);
  const set = useViewer((s) => s.setDisplay);
  const engine = useViewer((s) => s.engine);
  const ready = useViewer((s) => s.status === 'ready');

  return (
    <>
      <section className="group">
        <div className="group-title">
          <span className="eyebrow">Section plane</span>
        </div>
        <Toggle
          label="Cut through the model"
          checked={display.clipEnabled}
          onChange={(v) => set('clipEnabled', v)}
        />
        {display.clipEnabled && (
          <>
            <div className="seg" style={{ marginTop: 9 }}>
              {CLIP_AXES.map((axis) => (
                <button
                  key={axis}
                  className="seg-btn"
                  aria-pressed={display.clipAxis === axis}
                  onClick={() => set('clipAxis', axis)}
                  style={{ color: display.clipAxis === axis ? undefined : `var(--axis-${axis})` }}
                >
                  {axis.toUpperCase()}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <Slider
                label="Plane position"
                value={display.clipT}
                min={0}
                max={1}
                step={0.005}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => set('clipT', v)}
              />
            </div>
          </>
        )}
      </section>

      <section className="group">
        <div className="group-title">
          <span className="eyebrow">Assembly</span>
        </div>
        <Slider
          label="Pull the parts apart"
          value={display.explode}
          min={0}
          max={1}
          step={0.01}
          disabled={!ready || !engine?.canExplode}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set('explode', v)}
        />
        {!ready ? (
          <p className="hint" style={{ padding: '6px 0 0' }}>Open a model to use this.</p>
        ) : (
          !engine?.canExplode && (
            <p className="hint" style={{ padding: '6px 0 0', textAlign: 'left' }}>
              This model is a single part, so there is nothing to separate.
            </p>
          )
        )}
      </section>

      <section className="group">
        <div className="group-title">
          <span className="eyebrow">Surface</span>
        </div>
        {engine?.canTint ? (
          <>
            <span className="field-label">Colour</span>
            <div className="swatches" style={{ marginTop: 7 }}>
              {TINTS.map((hex) => (
                <button
                  key={hex}
                  className="swatch"
                  style={{ background: hex }}
                  aria-pressed={display.tint === hex}
                  aria-label={`Use ${hex}`}
                  onClick={() => set('tint', hex)}
                />
              ))}
            </div>
          </>
        ) : (
          <p className="hint" style={{ padding: '2px 0 8px', textAlign: 'left' }}>
            This file brings its own materials, so the surface colour comes from the model.
          </p>
        )}
        <div style={{ marginTop: 10 }}>
          <Slider
            label="Light level"
            value={display.environment}
            min={0}
            max={3}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => set('environment', v)}
          />
          <Slider
            label="Exposure"
            value={display.exposure}
            min={0.2}
            max={2.5}
            step={0.05}
            format={(v) => `${v.toFixed(2)}`}
            onChange={(v) => set('exposure', v)}
          />
        </div>
      </section>

      <section className="group">
        <div className="group-title">
          <span className="eyebrow">Stage</span>
        </div>
        <Toggle label="Grid" checked={display.grid} onChange={(v) => set('grid', v)} />
        <Toggle label="Axes" checked={display.axes} onChange={(v) => set('axes', v)} />
        <Toggle label="Shadows" checked={display.shadows} onChange={(v) => set('shadows', v)} />
        <Toggle label="Turntable" checked={display.autoRotate} onChange={(v) => set('autoRotate', v)} />
      </section>
    </>
  );
}

/* ----------------------------------------------------------------- panel */

export function Inspector() {
  const tab = useViewer((s) => s.tab);
  const setTab = useViewer((s) => s.setTab);

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="tab"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tabpanel" role="tabpanel">
        {tab === 'model' && <ModelTab />}
        {tab === 'tree' && <TreeTab />}
        {tab === 'display' && <DisplayTab />}
      </div>
    </aside>
  );
}
