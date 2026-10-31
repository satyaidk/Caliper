import { useMemo, useState } from 'react';
import { useViewer, FILAMENTS, LAYER_HEIGHTS, useMm, type ModelEntry } from '@/store/useViewer';
import { colourName } from '@/lib/colours';
import { area, bytes, count, degrees, dim, grams, ms, shortName, volume } from '@/lib/format';
import { PIPELINE_COPY } from '@/lib/formats';
import { BEDS, MM_PER, bedById, fitOnBed } from '@/lib/printers';
import { generateLayerPlan, layerIndexAtFraction } from '@/lib/slicing';
import { MAX_MODELS } from '@/lib/intake';
import type { Measurement, SourceUnit, UnitSystem } from '@/types';
import {
  IconAdd,
  IconAngle,
  IconArrange,
  IconCheckup,
  IconDiameter,
  IconClose,
  IconDistance,
  IconEye,
  IconEyeOff,
  IconFile,
  IconObjects,
  IconPreview,
  IconPlate,
  IconPrinter,
  IconSize,
  IconSpool,
  IconTrash,
  IconUndo,
} from './Icons';
import { ObjectList } from './ObjectList';
import { Field, SideSection, Switch } from './ui';

const UNITS: UnitSystem[] = ['mm', 'cm', 'm', 'in'];
const SOURCE_UNITS: { value: SourceUnit; label: string }[] = [
  { value: 'mm', label: 'millimetres' },
  { value: 'cm', label: 'centimetres' },
  { value: 'm', label: 'metres' },
  { value: 'in', label: 'inches' },
];

/** PLA's density. The weight readout is labelled with it, so the assumption is visible. */
const PLA_DENSITY = 1.24;

/* ---------------------------------------------------------------- printer */

function PrinterSection() {
  const bedId = useViewer((s) => s.bedId);
  const setBed = useViewer((s) => s.setBed);
  const model = useViewer((s) => s.model);
  const several = useViewer((s) => s.models.length > 1);
  const plate = useViewer((s) => s.plate);
  const unit = useViewer((s) => s.unit);
  const mm = useMm();
  const bed = bedById(bedId);

  let verdict: JSX.Element | null = null;
  if (several && bed.size) {
    // With several models the question is where they are, not only how big.
    verdict = plate.fits ? (
      <p className="verdict" data-tone="ok">
        Everything on the plate fits.
      </p>
    ) : (
      <p className="verdict" data-tone="bad">
        Something sticks out of the build area. Arrange the plate, or move it in.
      </p>
    );
  } else if (model && bed.size) {
    const d = model.dimensions;
    const report = fitOnBed([d.x * mm, d.y * mm, d.z * mm], bed.size);
    const over = (['width', 'depth', 'height'] as const).filter((k) => report.over[k] > 0);
    verdict = report.fits ? (
      <p className="verdict" data-tone="ok">
        {report.turned ? 'Fits on the plate after a quarter turn.' : 'Fits on the plate.'}
      </p>
    ) : (
      <p className="verdict" data-tone="bad">
        Too big for this printer:{' '}
        {over.map((k, i) => (
          <span key={k}>
            {i > 0 && ', '}
            {dim(report.over[k], unit)} over in {k}
          </span>
        ))}
        .
      </p>
    );
  }

  return (
    <SideSection icon={<IconPrinter />} title="Printer">
      <label className="control">
        <span className="control-label">Build plate</span>
        <select className="select" value={bedId} onChange={(event) => setBed(event.target.value)}>
          {BEDS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {verdict}
      {model && plate.cellMm !== null && (
        <p className="note">
          Grid squares are {Number(plate.cellMm.toPrecision(3))} mm across
          {bed.size ? ', and the plate is drawn at the printer’s real size.' : '.'}
        </p>
      )}
    </SideSection>
  );
}

/* --------------------------------------------------------------- filament */

function FilamentSection() {
  const defaultColour = useViewer((s) => s.filament);
  const defaultPaint = useViewer((s) => s.paintAuthored);
  const model = useViewer((s) => s.model);
  const several = useViewer((s) => s.models.length > 1);
  const setFilament = useViewer((s) => s.setFilament);
  const setModelFilamentColor = useViewer((s) => s.setModelFilamentColor);
  // The swatches colour the active model; with nothing open they choose the
  // colour the next model starts in.
  const filament = model?.colour ?? defaultColour;
  const paintAuthored = model?.paintAuthored ?? defaultPaint;
  const authored = model?.authored ?? false;
  const known = FILAMENTS.find((f) => f.hex === filament);

  return (
    <SideSection icon={<IconSpool />} title="Filament" aside={<span className="side-count">{known?.name ?? 'Custom'}</span>}>
      {several && model && (
        <p className="note">
          Colouring <b>{shortName(model.name, 30)}</b>. Click another model, or its row under Plate, to colour that one.
        </p>
      )}
      <div className="swatches" role="radiogroup" aria-label="Filament colour">
        {FILAMENTS.map((f) => (
          <button
            type="button"
            key={f.hex}
            role="radio"
            aria-checked={f.hex === filament}
            aria-label={f.name}
            title={f.name}
            className="swatch"
            style={{ background: f.hex }}
            onClick={() => setFilament(f.hex)}
          />
        ))}
        <label className="swatch swatch-custom" title="Any colour">
          <input
            type="color"
            value={filament}
            aria-label="Pick any colour"
            onChange={(event) => setFilament(event.target.value)}
          />
        </label>
      </div>
      {model && model.filamentColors.length > 1 && (
        <div className="ams-colors" aria-label="Imported AMS filament colors">
          <p className="note">
            Choose a preset for each AMS slot, then assign slots to objects below. Preview changes do not edit the 3MF.
          </p>
          {model.filamentColors.map((slot) => (
            <details className="ams-color-slot" key={slot.index}>
              <summary className="ams-color-row">
                <span className="ams-color-label">
                  <i className="ams-color-dot" style={{ backgroundColor: slot.color }} aria-hidden />
                  AMS {slot.index + 1}
                </span>
                <span className="ams-color-current">{colourName(slot.color)}</span>
                <span className="ams-color-action">Change</span>
              </summary>
              <div className="ams-color-options" role="radiogroup" aria-label={`Suggested colors for AMS ${slot.index + 1}`}>
                {FILAMENTS.map((filament) => (
                  <button
                    type="button"
                    key={filament.hex}
                    className="ams-color-swatch"
                    role="radio"
                    aria-checked={filament.hex.toLowerCase() === slot.color.toLowerCase()}
                    aria-label={`${filament.name} for AMS ${slot.index + 1}`}
                    title={filament.name}
                    style={{ backgroundColor: filament.hex }}
                    onClick={() => setModelFilamentColor(model.id, slot.index, filament.hex)}
                  />
                ))}
                <label className="ams-color-custom" title="Choose a custom color">
                  <input
                    type="color"
                    value={slot.color}
                    aria-label={`Choose a custom color for AMS ${slot.index + 1}`}
                    onChange={(event) => setModelFilamentColor(model.id, slot.index, event.target.value)}
                  />
                  <span aria-hidden>+</span>
                </label>
              </div>
            </details>
          ))}
        </div>
      )}
      {authored && (
        <>
          <Switch
            checked={paintAuthored}
            onChange={(value) => setFilament(filament, value)}
            label="Paint over the file’s own colours"
          />
          <p className="note">This file brought its own materials, so they show until you paint over them.</p>
        </>
      )}
    </SideSection>
  );
}

/* ------------------------------------------------------------------- size */

function AxisRow({ axis, name, value, longest }: { axis: 'x' | 'y' | 'z'; name: string; value: number; longest: number }) {
  const unit = useViewer((s) => s.unit);
  return (
    <div className="dim" data-axis={axis}>
      <span className="dim-axis">{axis.toUpperCase()}</span>
      <span className="dim-name">{name}</span>
      <span className="dim-bar" aria-hidden>
        <i style={{ width: `${longest > 0 ? (value / longest) * 100 : 0}%` }} />
      </span>
      <span className="dim-val num">{dim(value, unit)}</span>
    </div>
  );
}

function SizeSection() {
  const model = useViewer((s) => s.model);
  const unit = useViewer((s) => s.unit);
  const setUnit = useViewer((s) => s.setUnit);
  const sourceUnit = useViewer((s) => s.sourceUnit);
  const setSourceUnit = useViewer((s) => s.setSourceUnit);
  const mm = useMm();
  if (!model) return null;

  const d = model.dimensions;
  const longest = Math.max(d.x, d.y, d.z) * mm;

  return (
    <SideSection
      icon={<IconSize />}
      title="Size"
      aside={
        <select
          className="select select-inline"
          value={unit}
          aria-label="Show sizes in"
          onChange={(event) => setUnit(event.target.value as UnitSystem)}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      }
    >
      <AxisRow axis="x" name="Width" value={d.x * mm} longest={longest} />
      <AxisRow axis="y" name="Height" value={d.y * mm} longest={longest} />
      <AxisRow axis="z" name="Depth" value={d.z * mm} longest={longest} />
      <Field label="Diagonal" value={dim(d.diagonal * mm, unit)} />
      <label className="control control-row">
        <span className="control-label">The file’s numbers are in</span>
        <select
          className="select"
          value={sourceUnit}
          onChange={(event) => setSourceUnit(event.target.value as SourceUnit)}
        >
          {SOURCE_UNITS.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </label>
    </SideSection>
  );
}

/* ------------------------------------------------------------------ plate */

/**
 * A number typed in the display unit, committed on Enter or blur. Typing goes
 * into a draft first, so a half-typed "-1" never throws the model across the
 * plate on its way to "-12". With no draft the field shows the live position,
 * so switching models or dragging one never leaves yesterday's number in it.
 */
function PositionInput({ axis, mm, onCommit }: { axis: 'x' | 'z'; mm: number; onCommit: (mm: number) => void }) {
  const unit = useViewer((s) => s.unit);
  const shown = Number((mm / MM_PER[unit]).toFixed(unit === 'mm' ? 1 : 3));
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    const text = draft;
    setDraft(null);
    if (text === null || text.trim() === '') return;
    const value = Number(text);
    if (Number.isFinite(value) && value !== shown) onCommit(value * MM_PER[unit]);
  };

  return (
    <label className="pos-input" data-axis={axis}>
      <b>{axis.toUpperCase()}</b>
      <input
        type="number"
        inputMode="decimal"
        step={unit === 'mm' ? 1 : 0.1}
        value={draft ?? String(shown)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          if (event.key === 'Escape') setDraft(null);
        }}
        aria-label={`Position along ${axis.toUpperCase()} in ${unit}`}
      />
      <span>{unit}</span>
    </label>
  );
}

function PlateRow({ entry, active }: { entry: ModelEntry; active: boolean }) {
  const setActive = useViewer((s) => s.setActiveModel);
  const setVisible = useViewer((s) => s.setModelVisible);
  const setColour = useViewer((s) => s.setModelColour);
  const remove = useViewer((s) => s.removeModel);
  const frameModel = useViewer((s) => s.frameModel);

  return (
    <li className="plate-row" data-active={active} data-hidden={!entry.visible}>
      <label className="plate-dot" style={{ background: entry.colour }} title={`Colour of ${entry.name}`}>
        <input
          type="color"
          value={entry.colour}
          onChange={(event) => setColour(entry.id, event.target.value)}
          aria-label={`Colour of ${entry.name}`}
        />
      </label>
      <button
        type="button"
        className="plate-name"
        onClick={() => setActive(entry.id)}
        onDoubleClick={() => {
          setActive(entry.id);
          frameModel(entry.id);
        }}
        aria-pressed={active}
        title={`${entry.name} — double-click to zoom to it`}
      >
        <span>{entry.name}</span>
        <small className="num">{count(entry.stats.triangles)} triangles</small>
      </button>
      <button
        type="button"
        className="obj-eye"
        onClick={() => setVisible(entry.id, !entry.visible)}
        aria-label={entry.visible ? `Hide ${entry.name}` : `Show ${entry.name}`}
        title={entry.visible ? 'Hide' : 'Show'}
      >
        {entry.visible ? <IconEye size={15} /> : <IconEyeOff size={15} />}
      </button>
      <button
        type="button"
        className="obj-eye"
        onClick={() => remove(entry.id)}
        aria-label={`Remove ${entry.name} from the plate`}
        title="Remove from the plate"
      >
        <IconClose size={12} />
      </button>
    </li>
  );
}

/**
 * Every model on the plate: pick the one to work on, give each its own colour,
 * hide or remove it, and place it to the millimetre. Dragging on the canvas
 * with the move tool (M) does the same placing by hand.
 */
function PlateSection({ onAdd }: { onAdd: () => void }) {
  const models = useViewer((s) => s.models);
  const activeId = useViewer((s) => s.activeId);
  const arrange = useViewer((s) => s.arrange);
  const setPosition = useViewer((s) => s.setModelPosition);
  const tool = useViewer((s) => s.measureTool);
  const setTool = useViewer((s) => s.setMeasureTool);
  const active = models.find((m) => m.id === activeId);
  if (!models.length) return null;

  return (
    <SideSection
      icon={<IconPlate size={16} />}
      title="Plate"
      aside={<span className="side-count num">{models.length}</span>}
    >
      <ul className="plate-list" aria-label="Models on the plate">
        {models.map((entry) => (
          <PlateRow key={entry.id} entry={entry} active={entry.id === activeId} />
        ))}
      </ul>
      {active && (
        <div className="control-row">
          <span className="control-label">Position</span>
          <div className="pos-inputs">
            <PositionInput axis="x" mm={active.position[0]} onCommit={(x) => setPosition(active.id, [x, active.position[1]])} />
            <PositionInput axis="z" mm={active.position[1]} onCommit={(z) => setPosition(active.id, [active.position[0], z])} />
          </div>
        </div>
      )}
      <div className="row-actions">
        <button type="button" className="btn" data-variant="ghost" onClick={onAdd} disabled={models.length >= MAX_MODELS}>
          <IconAdd size={15} />
          Add a model
        </button>
        {models.length > 1 && (
          <button type="button" className="btn" data-variant="ghost" onClick={arrange} title="Arrange (T)">
            <IconArrange size={15} />
            Arrange
          </button>
        )}
      </div>
      {models.length > 1 && tool !== 'move' && (
        <p className="note">
          <button type="button" className="link-btn" onClick={() => setTool('move')}>
            Pick up the move tool (M)
          </button>{' '}
          and drag models across the plate. Arrow keys nudge the active one.
        </p>
      )}
    </SideSection>
  );
}

/* ----------------------------------------------------------- measurements */

const GLYPH = {
  distance: <IconDistance size={14} />,
  diameter: <IconDiameter size={14} />,
  angle: <IconAngle size={14} />,
};

export function readout(measurement: Measurement, unit: UnitSystem, mm: number): string {
  if (measurement.tool === 'angle') return degrees(measurement.value);
  const value = dim(measurement.value * mm, unit);
  return measurement.tool === 'diameter' ? `Ø ${value}` : value;
}

function MeasureSection() {
  const measurements = useViewer((s) => s.measurements);
  const unit = useViewer((s) => s.unit);
  const remove = useViewer((s) => s.removeMeasurement);
  const clear = useViewer((s) => s.clearMeasurements);
  const undo = useViewer((s) => s.undoMeasure);
  const mm = useMm();
  if (!measurements.length) return null;

  return (
    <SideSection icon={<IconDistance />} title="Measurements" aside={<span className="side-count num">{measurements.length}</span>}>
      <ul className="measures">
        {measurements.map((measurement) => (
          <li key={measurement.id} className="measure">
            <span className="measure-glyph">{GLYPH[measurement.tool]}</span>
            <span className="measure-body">
              <span className="measure-value num">{readout(measurement, unit, mm)}</span>
              {measurement.delta && (
                <span className="measure-sub num">
                  <b data-axis="x">X</b> {dim(measurement.delta[0] * mm, unit)}
                  <b data-axis="y">Y</b> {dim(measurement.delta[1] * mm, unit)}
                  <b data-axis="z">Z</b> {dim(measurement.delta[2] * mm, unit)}
                </span>
              )}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => remove(measurement.id)}
              aria-label="Delete this measurement"
            >
              <IconTrash />
            </button>
          </li>
        ))}
      </ul>
      <div className="row-actions">
        <button type="button" className="btn" data-variant="ghost" onClick={undo}>
          <IconUndo />
          Undo last
        </button>
        <button type="button" className="btn" data-variant="ghost" onClick={clear}>
          <IconTrash />
          Clear all
        </button>
      </div>
    </SideSection>
  );
}

/* ------------------------------------------------------------------- file */

function FileSection() {
  const model = useViewer((s) => s.model);
  const selection = useViewer((s) => s.selection);
  if (!model) return null;

  return (
    <SideSection icon={<IconFile />} title="File" defaultOpen={false}>
      <Field label="Format" value={model.ext.toUpperCase()} />
      <Field label="Kind" value={PIPELINE_COPY[model.pipeline].title} />
      <Field label="Triangles" value={count(model.stats.triangles)} />
      <Field label="Parts" value={count(model.stats.meshes)} />
      <Field label="Size on disk" value={bytes(model.bytes)} />
      <Field label="Time to open" value={ms(model.parseMs)} />
      {selection && (
        <>
          <div className="field-sep" />
          <Field label="Selected part" value={selection.name} />
          <Field label="Its triangles" value={count(selection.triangles)} />
        </>
      )}
    </SideSection>
  );
}

/* ---------------------------------------------------------------- preview */

function LayerSection() {
  const layerHeight = useViewer((s) => s.layerHeight);
  const setLayerHeight = useViewer((s) => s.setLayerHeight);
  const layerAt = useViewer((s) => s.layerAt);
  const model = useViewer((s) => s.model);
  const unit = useViewer((s) => s.unit);
  // Layers run up through everything on the plate, as a slicer's do.
  const heightMm = useViewer((s) => s.scene.y);
  const layers = useMemo(() => generateLayerPlan(heightMm, { layerHeight }), [heightMm, layerHeight]);
  if (!model) return null;

  const total = layers.length;
  const layer = layerIndexAtFraction(layerAt, layers, heightMm);

  return (
    <SideSection icon={<IconPreview size={16} />} title="Layers">
      <label className="control control-row">
        <span className="control-label">Layer height</span>
        <select
          className="select"
          value={layerHeight}
          onChange={(event) => setLayerHeight(Number(event.target.value))}
        >
          {LAYER_HEIGHTS.map((h) => (
            <option key={h} value={h}>
              {h.toFixed(2)} mm
            </option>
          ))}
        </select>
      </label>
      <Field label="Layers in the part" value={count(total)} />
      <Field label="Cut at layer" value={`${count(layer)} of ${count(total)}`} />
      <Field label="Cut height" value={dim(layers[layer - 1]?.sliceZ ?? 0, unit)} />
      <p className="note">Drag the slider beside the plate to step through the part from the plate up.</p>
    </SideSection>
  );
}

function CheckupSection() {
  const report = useViewer((s) => s.report);
  const pending = useViewer((s) => s.reportPending);
  const unit = useViewer((s) => s.unit);
  const overhangDeg = useViewer((s) => s.overhangDeg);
  const setOverhangDeg = useViewer((s) => s.setOverhangDeg);
  const model = useViewer((s) => s.model);
  const mm = useMm();
  if (!model) return null;

  const mm2 = mm * mm;
  const mm3 = mm2 * mm;
  const closed = report?.openEdges === 0;
  const overhangShare =
    report?.overhangArea != null && report.area ? (report.overhangArea / report.area) * 100 : null;

  return (
    <SideSection icon={<IconCheckup />} title="Printability">
      {pending && !report && <p className="hint">Checking the surface…</p>}
      {!pending && !report && (
        <p className="hint">This model is too large to check in the browser without stalling it.</p>
      )}
      {report && (
        <>
          <Field
            label="Surface"
            value={
              report.openEdges === null
                ? 'Not checked'
                : closed
                  ? 'Closed'
                  : `${count(report.openEdges)} open edges`
            }
            tone={report.openEdges === null ? undefined : closed ? 'ok' : 'warn'}
          />
          {report.volume !== null && (
            <Field label={closed ? 'Volume' : 'Volume, if closed'} value={volume(report.volume * mm3, unit)} />
          )}
          {report.volume !== null && (
            <Field
              label={`Solid PLA at ${PLA_DENSITY} g/cm³`}
              value={grams(((report.volume * mm3) / 1000) * PLA_DENSITY)}
            />
          )}
          {report.area !== null && <Field label="Surface area" value={area(report.area * mm2, unit)} />}
          {report.overhangArea !== null && (
            <Field
              label="Overhang area"
              value={`${area(report.overhangArea * mm2, unit)}${overhangShare !== null ? ` (${overhangShare.toFixed(1)}%)` : ''}`}
              tone={report.overhangArea > 0 ? 'warn' : 'ok'}
            />
          )}
        </>
      )}
      <label className="control">
        <span className="control-label">
          Overhang limit <b className="num">{overhangDeg}°</b> from vertical
        </span>
        <input
          className="slider"
          type="range"
          min={20}
          max={75}
          step={5}
          value={overhangDeg}
          onChange={(event) => setOverhangDeg(Number(event.target.value))}
        />
      </label>
      <p className="note">
        Faces steeper than the limit are painted red on the model. A slicer would put support under them. Weight
        assumes a solid part; real prints are mostly infill.
      </p>
    </SideSection>
  );
}

/* ------------------------------------------------------------------ panel */

/**
 * The sidebar, in the order Bambu Studio's runs: the printer first, because the
 * plate is what every other number is read against; the filament; then the
 * objects. Preview swaps the editing sections for the layer and printability
 * readouts, as Bambu's Preview tab swaps its process settings for the legend.
 */
export function Sidebar({ onAdd }: { onAdd: () => void }) {
  const workspace = useViewer((s) => s.workspace);
  const model = useViewer((s) => s.model);
  const parts = useViewer((s) => s.parts);

  return (
    <aside className="sidebar" aria-label="Model settings">
      <PrinterSection />
      {workspace !== 'preview' && <PlateSection onAdd={onAdd} />}
      {workspace === 'preview' ? (
        <>
          <LayerSection />
          <CheckupSection />
          <SizeSection />
        </>
      ) : (
        <>
          <FilamentSection />
          {model && (
            <SideSection
              icon={<IconObjects />}
              title="Objects"
              aside={<span className="side-count num">{parts.length.toLocaleString()}</span>}
            >
              <ObjectList />
            </SideSection>
          )}
          <SizeSection />
          <MeasureSection />
          <FileSection />
          {!model && <p className="side-empty">Open a model and its size, parts and printability land here.</p>}
        </>
      )}
    </aside>
  );
}
