import { useViewer } from '@/store/useViewer';
import { bytes, count, dim, ms } from '@/lib/format';
import { PIPELINE_COPY } from '@/lib/formats';
import type { MeasureTool, UnitSystem } from '@/types';
import { IconDistance, IconDiameter, IconFit, IconTrash, IconUndo } from './Icons';

const UNITS: UnitSystem[] = ['mm', 'cm', 'm', 'in'];

const TOOLS: { id: Exclude<MeasureTool, 'off'>; label: string; keys: string; hint: string }[] = [
  {
    id: 'distance',
    label: 'Distance',
    keys: 'M',
    hint: 'Click two points on the model. The readout also splits the span into X, Y and Z.',
  },
  {
    id: 'diameter',
    label: 'Diameter',
    keys: 'D',
    hint: 'Click three points around a hole or a round edge to fit a circle through them.',
  },
];

/* ------------------------------------------------------------- primitives */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{value}</span>
    </div>
  );
}

function AxisRow({
  axis,
  name,
  value,
  longest,
  unit,
}: {
  axis: 'x' | 'y' | 'z';
  name: string;
  value: number;
  longest: number;
  unit: UnitSystem;
}) {
  return (
    <div className="dim" data-axis={axis}>
      <span className="dim-axis">{axis.toUpperCase()}</span>
      <span className="dim-name">{name}</span>
      <span className="dim-bar">
        <i style={{ width: `${longest > 0 ? (value / longest) * 100 : 0}%` }} />
      </span>
      <span className="dim-val">{dim(value, unit)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

/**
 * One scrolling panel, in the order the questions get asked: how big is it,
 * what else do I need to measure on it, what did I just click, and what is this
 * file. Tabs would hide two of those behind a click for no gain at this size.
 */
export function Panel() {
  const model = useViewer((s) => s.model);
  const unit = useViewer((s) => s.unit);
  const setUnit = useViewer((s) => s.setUnit);
  const selection = useViewer((s) => s.selection);
  const frameSelection = useViewer((s) => s.frameSelection);

  const tool = useViewer((s) => s.measureTool);
  const setTool = useViewer((s) => s.setMeasureTool);
  const measurements = useViewer((s) => s.measurements);
  const remove = useViewer((s) => s.removeMeasurement);
  const clear = useViewer((s) => s.clearMeasurements);
  const undo = useViewer((s) => s.undoMeasure);

  if (!model) {
    return (
      <aside className="panel" aria-label="Model details">
        <p className="hint">Open a model and its size lands here.</p>
      </aside>
    );
  }

  const d = model.dimensions;
  const longest = Math.max(d.x, d.y, d.z);
  const active = TOOLS.find((t) => t.id === tool);

  return (
    <aside className="panel" aria-label="Model details">
      {/* --- size ---------------------------------------------------------- */}
      <section className="group">
        <div className="group-title">
          <span className="eyebrow">Size</span>
          <select
            className="select select-unit"
            value={unit}
            aria-label="Display units"
            onChange={(event) => setUnit(event.target.value as UnitSystem)}
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>

        <AxisRow axis="x" name="Width" value={d.x} longest={longest} unit={unit} />
        <AxisRow axis="y" name="Height" value={d.y} longest={longest} unit={unit} />
        <AxisRow axis="z" name="Depth" value={d.z} longest={longest} unit={unit} />

        <div style={{ marginTop: 9 }}>
          <Row label="Diagonal" value={dim(d.diagonal, unit)} />
        </div>

        <p className="note">
          Most formats carry no unit. Caliper reads the file's numbers as {unit} — switch above if
          the source used something else.
        </p>
      </section>

      {/* --- measure ------------------------------------------------------- */}
      <section className="group">
        <div className="group-title">
          <span className="eyebrow">Measure</span>
          {measurements.length > 0 && <span className="tally mono">{measurements.length}</span>}
        </div>

        <div className="toolgrid">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className="toolcard"
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              {t.id === 'distance' ? <IconDistance size={17} /> : <IconDiameter size={17} />}
              <span>{t.label}</span>
              <kbd className="kbd">{t.keys}</kbd>
            </button>
          ))}
        </div>

        <p className="note">
          {active
            ? active.hint
            : 'Pick a tool, then click the model. Points lock onto the nearest corner or edge midpoint.'}
        </p>

        {measurements.length > 0 && (
          <>
            <ul className="measures">
              {measurements.map((measurement) => (
                <li key={measurement.id} className="measure">
                  <span className="measure-glyph">
                    {measurement.tool === 'distance' ? (
                      <IconDistance size={14} />
                    ) : (
                      <IconDiameter size={14} />
                    )}
                  </span>
                  <span className="measure-body">
                    <span className="measure-value mono">
                      {measurement.tool === 'diameter' && 'Ø '}
                      {dim(measurement.value, unit)}
                    </span>
                    {measurement.delta && (
                      <span className="measure-sub">
                        <b data-axis="x">X</b> {dim(measurement.delta[0], unit)}
                        <b data-axis="y">Y</b> {dim(measurement.delta[1], unit)}
                        <b data-axis="z">Z</b> {dim(measurement.delta[2], unit)}
                      </span>
                    )}
                  </span>
                  <button
                    className="measure-drop"
                    onClick={() => remove(measurement.id)}
                    aria-label="Delete this measurement"
                  >
                    <IconTrash />
                  </button>
                </li>
              ))}
            </ul>

            <div className="row-actions">
              <button className="btn" data-variant="ghost-line" onClick={undo}>
                <IconUndo />
                Undo last
              </button>
              <button className="btn" data-variant="ghost-line" onClick={clear}>
                <IconTrash />
                Clear all
              </button>
            </div>
          </>
        )}
      </section>

      {/* --- selection ----------------------------------------------------- */}
      {selection && (
        <section className="group">
          <div className="group-title">
            <span className="eyebrow">Selected part</span>
          </div>
          <Row label="Name" value={selection.name} />
          <Row label="Triangles" value={count(selection.triangles)} />
          <Row label="Vertices" value={count(selection.vertices)} />
          <div className="row-actions">
            <button className="btn" data-variant="ghost-line" onClick={frameSelection}>
              <IconFit size={15} />
              Zoom to it
            </button>
          </div>
        </section>
      )}

      {/* --- file ---------------------------------------------------------- */}
      <section className="group">
        <div className="group-title">
          <span className="eyebrow">File</span>
        </div>
        <Row label="Format" value={model.ext.toUpperCase()} />
        <Row label="Kind" value={PIPELINE_COPY[model.pipeline].title} />
        <Row label="Triangles" value={count(model.stats.triangles)} />
        <Row label="Parts" value={count(model.stats.meshes)} />
        <Row label="Size on disk" value={bytes(model.bytes)} />
        <Row label="Time to open" value={ms(model.parseMs)} />
      </section>
    </aside>
  );
}
