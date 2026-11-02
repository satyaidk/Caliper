import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewer, LAYER_HEIGHTS } from '@/store/useViewer';
import { useSlicer, type SliceResult } from '@/store/useSlicer';
import {
  FILAMENT_PROFILES,
  PLACEHOLDERS,
  printerById,
  type FilamentId,
  type InfillPattern,
  type SeamPosition,
} from '@/slicer/profiles';
import { PREVIEW_ROLES, type Finding, type Severity } from '@/slicer/verify';
import { ROLE_COLOURS } from '@/viewer/Toolpaths';
import { count, duration, grams } from '@/lib/format';
import { useIsCompact } from '@/hooks/useMediaQuery';
import {
  IconCheck,
  IconClose,
  IconDownload,
  IconFile,
  IconInfo,
  IconShield,
  IconSlice,
  IconSpool,
  IconWarn,
} from './Icons';
import { Field, Segmented, SideSection, Switch } from './ui';

/**
 * Everything about slicing the interface shows: the print settings in
 * Prepare, the slice button, progress, the checked result in Preview, and the
 * export dialog that stands between a file and a printer.
 *
 * The rule throughout: a file can only leave Caliper when the checker found
 * no errors, nothing changed since it was sliced, and the person has read the
 * warnings and ticked the first-print checklist.
 */

/** Asks for a G-code file and checks it against the chosen printer. */
export function chooseGcodeFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.gcode,.gco,.g,text/x.gcode';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void useSlicer.getState().checkFile(file);
  };
  input.click();
}

/* ------------------------------------------------------------- top bar --- */

/** "Slice plate", Bambu Studio's button, and "Export G-code" once there is a good result. */
export function SliceActions() {
  const models = useViewer((s) => s.models.length);
  const workspace = useViewer((s) => s.workspace);
  const status = useSlicer((s) => s.status);
  const progress = useSlicer((s) => s.progress);
  const result = useSlicer((s) => s.result);
  const slice = useSlicer((s) => s.slice);
  const setExportOpen = useSlicer((s) => s.setExportOpen);
  const compact = useIsCompact();
  if (!models || workspace === 'home') return null;

  const working = status === 'working';
  const exportable = !!result && result.source === 'caliper' && !result.stale && result.report.ok;
  const fresh = !!result && result.source === 'caliper' && !result.stale;

  return (
    <div className="slice-actions">
      <button
        type="button"
        className="topbar-btn slice-btn"
        data-variant={fresh ? 'ghost' : 'primary'}
        onClick={slice}
        disabled={working}
        title="Slice every visible model on the plate"
      >
        <IconSlice size={16} />
        <span className={compact ? 'sr-only' : undefined}>
          {working ? `Slicing ${Math.round(progress * 100)}%` : fresh ? 'Slice again' : 'Slice plate'}
        </span>
      </button>
      {exportable && workspace === 'preview' && (
        <button type="button" className="topbar-btn slice-btn" data-variant="primary" onClick={() => setExportOpen(true)}>
          <IconDownload size={15} />
          <span className={compact ? 'sr-only' : undefined}>Export G-code</span>
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ progress --- */

export function SliceProgress() {
  const status = useSlicer((s) => s.status);
  const progress = useSlicer((s) => s.progress);
  const note = useSlicer((s) => s.note);
  const cancel = useSlicer((s) => s.cancel);
  if (status !== 'working') return null;
  return (
    <>
      <div className="loadbar">
        <div className="loadbar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="loadcard slice-card" role="status" aria-live="polite">
        <span className="spinner" />
        <span>{note || 'Slicing'}</span>
        <span className="num">{Math.round(progress * 100)}%</span>
        <button type="button" className="btn" data-variant="ghost" onClick={cancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

/** Says so out loud when slicing fails, as well as in the sidebar. */
export function SliceErrorToast() {
  const error = useSlicer((s) => s.error);
  const toast = useViewer((s) => s.toast);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== shown.current) toast({ tone: 'error', title: 'Could not slice', text: error });
    shown.current = error;
  }, [error, toast]);
  return null;
}

/* ------------------------------------------------- print settings (Prepare) */

const PATTERNS: { value: InfillPattern; label: string; title: string }[] = [
  { value: 'grid', label: 'Grid', title: 'Lines in both directions on every layer' },
  { value: 'lines', label: 'Lines', title: 'One direction per layer, turning 90° each layer' },
];
const SEAMS: { value: SeamPosition; label: string; title: string }[] = [
  { value: 'rear', label: 'Rear', title: 'Start every outer wall at the back of the part' },
  { value: 'aligned', label: 'Aligned', title: 'Start each layer where the last one started' },
];

function NumberRow({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="control control-row">
      <span className="control-label">{label}</span>
      <span className="stepper">
        <button type="button" className="stepper-btn" aria-label={`Less ${label.toLowerCase()}`} onClick={() => onChange(Math.max(min, +(value - step).toFixed(3)))} disabled={value <= min}>
          −
        </button>
        <input
          type="number"
          inputMode="decimal"
          className="stepper-input num"
          value={value}
          min={min}
          max={max}
          step={step}
          aria-label={label}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
          }}
        />
        <button type="button" className="stepper-btn" aria-label={`More ${label.toLowerCase()}`} onClick={() => onChange(Math.min(max, +(value + step).toFixed(3)))} disabled={value >= max}>
          +
        </button>
        {suffix && <span className="stepper-suffix">{suffix}</span>}
      </span>
    </label>
  );
}

/**
 * Bambu Studio's Process block, cut to the settings that matter for a first
 * print. Every value here goes into the G-code header, so a file always says
 * how it was made.
 */
export function PrintSettingsSection() {
  const bedId = useViewer((s) => s.bedId);
  const layerHeight = useViewer((s) => s.layerHeight);
  const setLayerHeight = useViewer((s) => s.setLayerHeight);
  const filamentId = useSlicer((s) => s.filamentId);
  const setFilamentId = useSlicer((s) => s.setFilamentId);
  const process = useSlicer((s) => s.process);
  const setProcess = useSlicer((s) => s.setProcess);
  const reset = useSlicer((s) => s.resetProcess);
  const printer = printerById(bedId);
  const filament = FILAMENT_PROFILES.find((f) => f.id === filamentId)!;
  const tooHot = printer && (filament.nozzleTemp > printer.maxNozzleTemp || filament.firstLayerBedTemp > printer.maxBedTemp);

  return (
    <SideSection
      icon={<IconSlice />}
      title="Print settings"
      aside={
        <button type="button" className="link-btn side-reset" onClick={reset}>
          Reset
        </button>
      }
    >
      <label className="control control-row">
        <span className="control-label">Material</span>
        <select className="select" value={filamentId} onChange={(event) => setFilamentId(event.target.value as FilamentId)}>
          {FILAMENT_PROFILES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label} · {f.nozzleTemp} °C / {f.bedTemp} °C
            </option>
          ))}
        </select>
      </label>
      {tooHot && (
        <p className="verdict" data-tone="bad">
          {filament.label} needs more heat than {printer!.label} is rated for. Choose another material.
        </p>
      )}
      {filament.needsEnclosure && !tooHot && <p className="note">{filament.label} warps and gives off fumes: print it enclosed and ventilated.</p>}

      <label className="control control-row">
        <span className="control-label">Layer height</span>
        <select className="select" value={layerHeight} onChange={(event) => setLayerHeight(Number(event.target.value))}>
          {LAYER_HEIGHTS.filter((h) => !printer || h <= printer.nozzle * 0.75 + 1e-9).map((h) => (
            <option key={h} value={h}>
              {h.toFixed(2)} mm
            </option>
          ))}
        </select>
      </label>
      <NumberRow label="Walls" value={process.walls} min={1} max={10} onChange={(walls) => setProcess({ walls })} />
      <NumberRow label="Top layers" value={process.topLayers} min={0} max={20} onChange={(topLayers) => setProcess({ topLayers })} />
      <NumberRow label="Bottom layers" value={process.bottomLayers} min={1} max={20} onChange={(bottomLayers) => setProcess({ bottomLayers })} />
      <NumberRow
        label="Infill"
        value={Math.round(process.infillDensity * 100)}
        min={0}
        max={100}
        step={5}
        suffix="%"
        onChange={(v) => setProcess({ infillDensity: v / 100 })}
      />
      <div className="control control-row">
        <span className="control-label">Infill pattern</span>
        <Segmented label="Infill pattern" size="sm" value={process.infillPattern} options={PATTERNS} onChange={(infillPattern) => setProcess({ infillPattern })} />
      </div>
      <div className="control control-row">
        <span className="control-label">Seam</span>
        <Segmented label="Seam position" size="sm" value={process.seam} options={SEAMS} onChange={(seam) => setProcess({ seam })} />
      </div>
      <NumberRow label="Brim width" value={process.brimWidth} min={0} max={20} suffix="mm" onChange={(brimWidth) => setProcess({ brimWidth })} />
      <Switch checked={process.skirtLoops > 0} onChange={(on) => setProcess({ skirtLoops: on ? 1 : 0 })} label="Skirt to prime the nozzle" />
      <p className="note">
        No supports yet: overhangs past {process.overhangLimitDeg}° are reported after slicing so the part can be turned
        instead.
      </p>
    </SideSection>
  );
}

/**
 * For printers whose start sequence Caliper does not ship: the person pastes
 * one they trust. Only Caliper's own {placeholders} are filled in; anything
 * else stops the slice, and the checker reads the result like any other line.
 */
export function CustomGcodeSection() {
  const bedId = useViewer((s) => s.bedId);
  const custom = useSlicer((s) => s.custom[bedId]);
  const setCustom = useSlicer((s) => s.setCustom);
  const printer = printerById(bedId);
  if (!printer || printer.startMode !== 'custom') return null;
  const empty = !custom?.start?.trim();

  return (
    <SideSection icon={<IconFile />} title="Custom G-code" defaultOpen={empty}>
      <p className="note">
        {printer.label} needs a start sequence that heats, homes and levels it. Paste one you trust, for example from
        your printer’s documentation. It must <b>home (G28)</b> and <b>wait for heat (M190, M109)</b> before printing;
        the checker refuses the file otherwise.
      </p>
      <label className="control">
        <span className="control-label">Start sequence</span>
        <textarea
          className="code-input"
          spellCheck={false}
          rows={8}
          value={custom?.start ?? ''}
          placeholder={'G90\nM83\nM140 S{first_bed_temp}\nG28\nM190 S{first_bed_temp}\nM109 S{first_nozzle_temp}\nG92 E0'}
          onChange={(event) => setCustom(printer.id, { start: event.target.value })}
        />
      </label>
      <label className="control">
        <span className="control-label">End sequence (blank for Caliper’s own)</span>
        <textarea
          className="code-input"
          spellCheck={false}
          rows={4}
          value={custom?.end ?? ''}
          onChange={(event) => setCustom(printer.id, { end: event.target.value })}
        />
      </label>
      <details className="placeholders">
        <summary>Placeholders you can use</summary>
        <p className="note">
          {PLACEHOLDERS.map((p) => (
            <code key={p}>{`{${p}}`}</code>
          ))}
        </p>
        <p className="note">
          Sequences copied from Bambu Studio or PrusaSlicer use their own variables ([bed_temperature] and the like) and
          conditions. Replace those with numbers or the placeholders above.
        </p>
      </details>
    </SideSection>
  );
}

/** One line under the printer picker saying how far Caliper supports it. */
export function PrinterSupport() {
  const bedId = useViewer((s) => s.bedId);
  const printer = printerById(bedId);
  if (!printer)
    return (
      <p className="note">
        <IconInfo size={13} /> Choose a printer to slice: its bed, limits and temperatures are what the G-code is
        checked against.
      </p>
    );
  return (
    <div className="support-note" data-mode={printer.startMode}>
      <span className="support-badge">{printer.startMode === 'builtin' ? 'Slicing: experimental' : 'Slicing: needs your start G-code'}</span>
      <ul>
        {printer.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------- result (Preview) ------ */

const SEVERITY_LABEL: Record<Severity, string> = { error: 'Error', warning: 'Warning', info: 'Note' };

function FindingRow({ finding, onLayer }: { finding: Finding; onLayer: (layer: number) => void }) {
  const [open, setOpen] = useState(finding.severity === 'error');
  return (
    <li className="finding" data-severity={finding.severity}>
      <button type="button" className="finding-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="finding-icon" aria-hidden>
          {finding.severity === 'info' ? <IconInfo /> : <IconWarn />}
        </span>
        <span className="finding-title">
          <span className="sr-only">{SEVERITY_LABEL[finding.severity]}: </span>
          {finding.title}
        </span>
        {finding.count > 1 && <span className="finding-count num">×{count(finding.count)}</span>}
      </button>
      {open && (
        <div className="finding-body">
          <p>{finding.detail}</p>
          <p className="finding-meta">
            <code>{finding.code}</code>
            {finding.line !== undefined && <span>line {count(finding.line)}</span>}
            {finding.layer !== undefined && (
              <button type="button" className="link-btn" onClick={() => onLayer(finding.layer!)}>
                show layer {finding.layer + 1}
              </button>
            )}
          </p>
        </div>
      )}
    </li>
  );
}

function Verdict({ result }: { result: SliceResult }) {
  const errors = result.report.findings.filter((f) => f.severity === 'error').length;
  const warnings = result.report.findings.filter((f) => f.severity === 'warning').length;
  if (result.stale)
    return (
      <div className="verdict-card" data-tone="warn">
        <IconWarn size={18} />
        <div>
          <strong>Out of date</strong>
          <span>The plate or the settings changed after slicing. Slice again before exporting.</span>
        </div>
      </div>
    );
  if (errors)
    return (
      <div className="verdict-card" data-tone="bad">
        <IconClose size={18} />
        <div>
          <strong>Not safe to print: {errors} {errors === 1 ? 'problem' : 'problems'}</strong>
          <span>Export is blocked until every error below is fixed.</span>
        </div>
      </div>
    );
  return (
    <div className="verdict-card" data-tone={warnings ? 'warn' : 'ok'}>
      <IconCheck size={18} />
      <div>
        <strong>{warnings ? `Passed the checks, with ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : 'Passed every check'}</strong>
        <span>
          {result.source === 'caliper'
            ? 'Every line was read back and checked against the printer’s limits.'
            : 'Checked against Caliper’s limits for this printer. Vendor start sequences can trip strict checks.'}
        </span>
      </div>
    </div>
  );
}

export function SliceResultSection() {
  const result = useSlicer((s) => s.result);
  const setViewLayer = useSlicer((s) => s.setViewLayer);
  const setExportOpen = useSlicer((s) => s.setExportOpen);
  const clear = useSlicer((s) => s.clearResult);
  const slice = useSlicer((s) => s.slice);
  const [showInfo, setShowInfo] = useState(false);
  if (!result) return null;
  const { stats, findings } = result.report;
  const printer = printerById(result.printerId);
  const shown = findings.filter((f) => showInfo || f.severity !== 'info');
  const hiddenInfo = findings.length - findings.filter((f) => f.severity !== 'info').length;
  const exportable = result.source === 'caliper' && !result.stale && result.report.ok;

  return (
    <SideSection icon={<IconShield />} title={result.source === 'caliper' ? 'Sliced result' : 'Checked file'}>
      <Verdict result={result} />
      <Field label="File" value={<span title={result.name}>{result.name.length > 28 ? `${result.name.slice(0, 26)}…` : result.name}</span>} />
      {printer && <Field label="Printer" value={printer.label} />}
      <Field label="Print time" value={`≈ ${duration(stats.seconds)}`} />
      <Field
        label="Filament"
        value={`${(stats.filamentMm / 1000).toFixed(2)} m${stats.filamentGrams !== null ? ` · ${grams(stats.filamentGrams)}` : ''}`}
      />
      <Field label="Layers" value={count(stats.layers)} />
      <Field label="Hottest nozzle / bed" value={`${stats.maxNozzleTemp} °C / ${stats.maxBedTemp} °C`} />
      <Field label="Peak flow" value={`${stats.peakFlow.toFixed(1)} mm³/s`} tone={printer && stats.peakFlow > printer.hotendMaxFlow ? 'warn' : undefined} />
      <p className="note">Time counts moves and acceleration, not heating. Check the first layer in the preview before printing.</p>

      <h3 className="side-sub">
        Checks
        {hiddenInfo > 0 && (
          <button type="button" className="link-btn" onClick={() => setShowInfo((v) => !v)}>
            {showInfo ? 'Hide notes' : `Show ${hiddenInfo} ${hiddenInfo === 1 ? 'note' : 'notes'}`}
          </button>
        )}
      </h3>
      {shown.length ? (
        <ul className="findings">
          {shown.map((finding) => (
            <FindingRow key={finding.code} finding={finding} onLayer={setViewLayer} />
          ))}
        </ul>
      ) : (
        <p className="hint">No errors or warnings.</p>
      )}

      <div className="row-actions slice-row">
        {result.source === 'caliper' ? (
          <>
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => setExportOpen(true)}
              disabled={!exportable}
              title={exportable ? undefined : result.stale ? 'Slice again first' : 'Fix the errors first'}
            >
              <IconDownload size={15} />
              Export G-code
            </button>
            {result.stale && (
              <button type="button" className="btn" data-variant="ghost" onClick={slice}>
                <IconSlice size={15} />
                Slice again
              </button>
            )}
          </>
        ) : (
          <button type="button" className="btn" data-variant="ghost" onClick={clear}>
            Close the file
          </button>
        )}
      </div>
    </SideSection>
  );
}

/** Before slicing: what will happen, and the button. Also where any G-code file is checked. */
export function SliceStartSection() {
  const status = useSlicer((s) => s.status);
  const error = useSlicer((s) => s.error);
  const result = useSlicer((s) => s.result);
  const slice = useSlicer((s) => s.slice);
  const bedId = useViewer((s) => s.bedId);
  const hasModels = useViewer((s) => s.models.length > 0);
  const printer = printerById(bedId);

  return (
    <SideSection icon={<IconSlice />} title="Slice and check" defaultOpen={!result}>
      {!result && (
        <p className="note">
          Slicing turns the plate into G-code for {printer ? printer.label : 'your printer'}. Every line is then read
          back and checked: limits, temperatures, homing, flow. Nothing can be exported with an error.
        </p>
      )}
      {status === 'failed' && error && (
        <p className="verdict" data-tone="bad" role="alert">
          {error}
        </p>
      )}
      <div className="row-actions">
        {hasModels && (
          <button type="button" className="btn" data-variant={result ? 'ghost' : 'primary'} onClick={slice} disabled={status === 'working' || !printer}>
            <IconSlice size={15} />
            {result?.source === 'caliper' ? 'Slice again' : 'Slice plate'}
          </button>
        )}
        <button type="button" className="btn" data-variant="ghost" onClick={chooseGcodeFile} disabled={status === 'working' || !printer}>
          <IconShield size={15} />
          Check a G-code file
        </button>
      </div>
      <p className="note">Check a file from any slicer before sending it: it is read here and never uploaded.</p>
    </SideSection>
  );
}

/* --------------------------------------------- canvas: slider and legend --- */

/** The Preview's layer slider, stepping through the G-code's own layers. */
export function ToolpathSlider() {
  const result = useSlicer((s) => s.result);
  const viewLayer = useSlicer((s) => s.viewLayer);
  const setViewLayer = useSlicer((s) => s.setViewLayer);
  if (!result) return null;
  const { layerZ } = result.report.preview;
  const total = layerZ.length;
  if (!total) return null;
  const layer = Math.min(viewLayer, total - 1);
  const goTo = (next: number) => setViewLayer(Math.min(total - 1, Math.max(0, next)));

  return (
    <div className="layers" aria-label="Layer slider">
      <div className="layers-read">
        <b className="num">{(layer + 1).toLocaleString()}</b>
        <span className="num">of {total.toLocaleString()}</span>
        <span className="num">{layerZ[layer].toFixed(2)} mm</span>
      </div>
      <button type="button" className="layers-step" onClick={() => goTo(layer + 1)} aria-label="Up one layer">
        +
      </button>
      <input
        className="layers-range"
        type="range"
        min={0}
        max={total - 1}
        step={1}
        value={layer}
        aria-label={`Layer ${layer + 1} of ${total}`}
        onChange={(event) => goTo(Number(event.target.value))}
      />
      <button type="button" className="layers-step" onClick={() => goTo(layer - 1)} aria-label="Down one layer">
        −
      </button>
    </div>
  );
}

export function ToolpathLegend() {
  const result = useSlicer((s) => s.result);
  const showTravel = useSlicer((s) => s.showTravel);
  const setShowTravel = useSlicer((s) => s.setShowTravel);
  const present = useMemo(() => {
    if (!result) return [];
    const seen = new Set<number>();
    for (const r of result.report.preview.roles) seen.add(r);
    return [...seen].sort((a, b) => a - b);
  }, [result]);
  if (!result) return null;

  return (
    <div className="legend" aria-label="Legend">
      {present.map((role) => (
        <div className="legend-row" key={role}>
          <i style={{ background: ROLE_COLOURS[role] }} />
          {PREVIEW_ROLES[role]}
        </div>
      ))}
      <label className="legend-row legend-toggle">
        <input type="checkbox" checked={showTravel} onChange={(event) => setShowTravel(event.target.checked)} />
        Travel moves on this layer
      </label>
    </div>
  );
}

/* ------------------------------------------------------- export dialog --- */

/**
 * The last step before a file reaches a printer. Warnings are listed again
 * and must be acknowledged; the checklist covers what no file can check: the
 * printer in front of you.
 */
export function ExportDialog() {
  const open = useSlicer((s) => s.exportOpen);
  const result = useSlicer((s) => s.result);
  const setOpen = useSlicer((s) => s.setExportOpen);
  const download = useSlicer((s) => s.download);
  const dialog = useRef<HTMLDialogElement>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      setTicked(new Set());
      node.showModal();
    }
    if (!open && node.open) node.close();
  }, [open]);

  const printer = result ? printerById(result.printerId) : null;
  const filament = result?.filamentId ? FILAMENT_PROFILES.find((f) => f.id === result.filamentId) : null;
  const warnings = result?.report.findings.filter((f) => f.severity === 'warning') ?? [];

  const checks = printer
    ? [
        { id: 'printer', text: `The printer is a ${printer.label} with a ${printer.nozzle} mm nozzle.` },
        { id: 'filament', text: `${filament?.label ?? 'The right filament'} is loaded, and the bed is clean and empty.` },
        {
          id: 'level',
          text:
            printer.id === 'ender-3'
              ? 'The bed has been levelled by hand: this printer does not level itself.'
              : 'The bed is level (this printer measures it at the start).',
        },
        { id: 'watch', text: 'I will watch the first layer and I know how to stop the printer.' },
        ...(warnings.length ? [{ id: 'warnings', text: `I have read the ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}.` }] : []),
      ]
    : [];
  const ready = checks.length > 0 && checks.every((c) => ticked.has(c.id));

  return (
    <dialog ref={dialog} className="dialog export-dialog" aria-labelledby="export-title" onClose={() => setOpen(false)}>
      {result && printer && (
        <form method="dialog" className="export-form" onSubmit={(event) => event.preventDefault()}>
          <header className="dialog-head">
            <h2 id="export-title">
              <IconShield size={18} /> Before this goes to the printer
            </h2>
            <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
              <IconClose />
            </button>
          </header>
          <div className="export-body">
            <p className="note">
              <b>{result.name}</b> passed every check Caliper makes. Caliper’s slicer is new: these checks catch files
              that could damage a printer, but they cannot see your printer. Please confirm:
            </p>
            {warnings.length > 0 && (
              <ul className="export-warnings">
                {warnings.map((w) => (
                  <li key={w.code}>
                    <IconWarn size={14} /> <b>{w.title}.</b> {w.detail}
                  </li>
                ))}
              </ul>
            )}
            <ul className="checklist">
              {checks.map((c) => (
                <li key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={ticked.has(c.id)}
                      onChange={(event) =>
                        setTicked((prev) => {
                          const next = new Set(prev);
                          if (event.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          return next;
                        })
                      }
                    />
                    <span>{c.text}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="note">
              <IconSpool size={13} /> ≈ {duration(result.report.stats.seconds)} ·{' '}
              {(result.report.stats.filamentMm / 1000).toFixed(2)} m of filament · first layer at{' '}
              {result.report.stats.firstLayerZ?.toFixed(2)} mm
            </p>
          </div>
          <footer className="export-foot">
            <button type="button" className="btn" data-variant="ghost" onClick={() => setOpen(false)}>
              Not yet
            </button>
            <button type="button" className="btn" data-variant="primary" disabled={!ready} onClick={download}>
              <IconDownload size={15} />
              Save G-code
            </button>
          </footer>
        </form>
      )}
    </dialog>
  );
}
