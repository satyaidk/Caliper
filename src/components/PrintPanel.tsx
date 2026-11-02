/**
 * The slicing side of the sidebar: print settings in Prepare, the Slice bar
 * pinned under them, and the print ticket in Preview — job summary, pre-flight
 * checklist and the download, which stays locked until every check passes.
 */
import { useViewer, DEFAULT_SLICE_CHOICES } from '@/store/useViewer';
import { FILAMENT_PRESETS, PROCESS_PRESETS } from '@/lib/bambu/profiles';
import { PLATE_TYPES, type Adhesion, type PlateType } from '@/lib/bambu/settings';
import { featureColor, legendOrder } from '@/lib/featureColors';
import { formatDuration } from '@/lib/gcode';
import type { SliceStage } from '@/viewer/sliceProtocol';
import { IconCheck, IconClose, IconDownload, IconPrinter, IconWarn } from './Icons';
import { Segmented, SideSection, Switch } from './ui';

const STAGE_COPY: Record<SliceStage, string> = {
  profiles: 'Loading Bambu profiles',
  slicing: 'Slicing layers',
  checking: 'Checking the G-code',
  packaging: 'Packing the print file',
};

const QUALITY_COPY: Record<string, string> = { fine: 'Fine', standard: 'Standard', draft: 'Draft' };

/** Plates the chosen filament may go on, per its profile (0 °C means "not on this plate"). */
const PLATE_FOR_FILAMENT: Record<string, PlateType[]> = {
  'bambu-pla-basic': ['Textured PEI Plate', 'Cool Plate', 'High Temp Plate'],
  'generic-pla': ['Textured PEI Plate', 'Cool Plate', 'High Temp Plate'],
  'bambu-petg-basic': ['Textured PEI Plate', 'Engineering Plate', 'High Temp Plate'],
  'generic-petg': ['Textured PEI Plate', 'Engineering Plate', 'High Temp Plate'],
};

export function PrintSettingsSection() {
  const choices = useViewer((s) => s.slice.choices);
  const setChoices = useViewer((s) => s.setSliceChoices);
  const bedId = useViewer((s) => s.bedId);
  const setBed = useViewer((s) => s.setBed);
  const allowedPlates = PLATE_FOR_FILAMENT[choices.filamentId] ?? [];

  return (
    <SideSection icon={<IconPrinter />} title="Print settings" aside={<span className="side-count">P1S, 0.4 mm nozzle</span>}>
      {bedId !== 'bambu-256' && (
        <div className="print-alert" role="alert">
          <p>The plate is not set to the P1S, so slicing is off.</p>
          <button type="button" className="btn" data-variant="primary" onClick={() => setBed('bambu-256')}>
            Use the P1S plate
          </button>
        </div>
      )}
      <label className="control">
        <span className="control-label">Filament</span>
        <select
          className="select"
          value={choices.filamentId}
          onChange={(event) => {
            const filamentId = event.target.value;
            const plates = PLATE_FOR_FILAMENT[filamentId] ?? [];
            setChoices({
              filamentId,
              plateType: plates.includes(choices.plateType) ? choices.plateType : 'Textured PEI Plate',
            });
          }}
        >
          {FILAMENT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <label className="control">
        <span className="control-label">Build plate on the printer</span>
        <select
          className="select"
          value={choices.plateType}
          onChange={(event) => setChoices({ plateType: event.target.value as PlateType })}
        >
          {PLATE_TYPES.map((plate) => (
            <option key={plate.id} value={plate.id} disabled={!allowedPlates.includes(plate.id)}>
              {plate.label}
              {allowedPlates.includes(plate.id) ? '' : ' (not for this filament)'}
            </option>
          ))}
        </select>
      </label>
      <div className="control">
        <span className="control-label">Quality</span>
        <Segmented
          label="Quality"
          value={choices.processId}
          options={PROCESS_PRESETS.map((preset) => ({
            value: preset.id,
            label: QUALITY_COPY[preset.id] ?? preset.label,
            title: preset.label,
          }))}
          onChange={(processId) => setChoices({ processId })}
        />
      </div>
      <label className="control">
        <span className="control-label">
          Infill <b className="num">{choices.infillPercent}%</b>
        </span>
        <input
          className="slider"
          type="range"
          min={0}
          max={100}
          step={5}
          value={choices.infillPercent}
          onChange={(event) => setChoices({ infillPercent: Number(event.target.value) })}
        />
      </label>
      <div className="control control-row">
        <span className="control-label">Walls</span>
        <div className="stepper" role="group" aria-label="Walls">
          <button
            type="button"
            aria-label="Fewer walls"
            disabled={choices.wallLoops <= 1}
            onClick={() => setChoices({ wallLoops: choices.wallLoops - 1 })}
          >
            −
          </button>
          <output className="num" aria-live="polite">
            {choices.wallLoops}
          </output>
          <button
            type="button"
            aria-label="More walls"
            disabled={choices.wallLoops >= 6}
            onClick={() => setChoices({ wallLoops: choices.wallLoops + 1 })}
          >
            +
          </button>
        </div>
      </div>
      <div className="control">
        <span className="control-label">First layer</span>
        <Segmented<Adhesion>
          label="First layer adhesion"
          value={choices.adhesion}
          options={[
            { value: 'skirt', label: 'Skirt' },
            { value: 'brim', label: 'Brim' },
            { value: 'none', label: 'None' },
          ]}
          onChange={(adhesion) => setChoices({ adhesion })}
        />
      </div>
      <div className="control">
        <Switch
          checked={choices.supports}
          onChange={(supports) => setChoices({ supports })}
          label="Supports under overhangs"
        />
      </div>
      {JSON.stringify(choices) !== JSON.stringify(DEFAULT_SLICE_CHOICES) && (
        <button type="button" className="link-btn" onClick={() => setChoices(DEFAULT_SLICE_CHOICES)}>
          Reset to Bambu defaults
        </button>
      )}
    </SideSection>
  );
}

/** Pinned at the foot of the sidebar, like Bambu Studio's Slice plate button. */
export function SliceBar() {
  const slice = useViewer((s) => s.slice);
  const model = useViewer((s) => s.model);
  const bedId = useViewer((s) => s.bedId);
  const sliceNow = useViewer((s) => s.sliceNow);
  const cancelSlice = useViewer((s) => s.cancelSlice);
  const setWorkspace = useViewer((s) => s.setWorkspace);
  const workspace = useViewer((s) => s.workspace);
  if (!model) return null;

  if (slice.status === 'running') {
    return (
      <div className="slice-bar" data-state="running">
        <div className="slice-progress" role="status" aria-live="polite">
          <span className="slice-spinner" aria-hidden="true" />
          {STAGE_COPY[slice.stage ?? 'profiles']}…
        </div>
        <button type="button" className="btn" data-variant="ghost" onClick={cancelSlice}>
          Cancel
        </button>
      </div>
    );
  }
  if (slice.status === 'done' && workspace !== 'preview') {
    return (
      <div className="slice-bar">
        <button type="button" className="btn slice-go" data-variant="primary" onClick={() => setWorkspace('preview')}>
          Show the sliced plate
        </button>
      </div>
    );
  }
  if (slice.status === 'done') return null;
  return (
    <div className="slice-bar">
      <button
        type="button"
        className="btn slice-go"
        data-variant="primary"
        disabled={bedId !== 'bambu-256'}
        onClick={() => void sliceNow()}
      >
        Slice plate
      </button>
      {slice.status === 'error' && (
        <p className="slice-error" role="alert">
          {slice.error}
        </p>
      )}
    </div>
  );
}

/** Preview: what was sliced, whether it is safe to print, and the download. */
export function PrintTicket() {
  const slice = useViewer((s) => s.slice);
  const downloadSlice = useViewer((s) => s.downloadSlice);
  const setWorkspace = useViewer((s) => s.setWorkspace);
  const summary = slice.summary;

  if (slice.status === 'done' && slice.imported) return <ImportedTicket />;

  if (slice.status !== 'done' || !summary) {
    return (
      <SideSection icon={<IconPrinter />} title="Print">
        <p className="side-empty">
          {slice.status === 'running'
            ? 'Slicing…'
            : 'Slice the plate to see its toolpaths, print time and filament here.'}
        </p>
        {slice.status !== 'running' && (
          <button type="button" className="btn" data-variant="ghost" onClick={() => setWorkspace('prepare')}>
            Back to print settings
          </button>
        )}
      </SideSection>
    );
  }

  const { stats, preflight, settings } = summary;
  const failing = preflight.checks.filter((check) => check.status === 'fail');
  const warnings = preflight.checks.filter((check) => check.status === 'warn');
  const filamentLabel = FILAMENT_PRESETS.find((preset) => preset.profile === settings.filamentName)?.label ?? settings.filamentType;

  return (
    <section className="ticket" aria-label="Print summary">
      <header className="ticket-head">
        <span className="ticket-time num">{formatDuration(stats.printSeconds)}</span>
        <span className="ticket-sub">of printing, plus the printer&rsquo;s own heating, levelling and purge</span>
      </header>
      <dl className="ticket-facts">
        <div>
          <dt>Filament</dt>
          <dd className="num">
            {stats.filamentGrams.toFixed(1)} g, {(stats.filamentMm / 1000).toFixed(2)} m
          </dd>
        </div>
        <div>
          <dt>Layers</dt>
          <dd className="num">
            {stats.layers.toLocaleString()} × {settings.layerHeight} mm
          </dd>
        </div>
        <div>
          <dt>Material</dt>
          <dd>
            {filamentLabel}, {settings.nozzleTemperature} °C
          </dd>
        </div>
        <div>
          <dt>Plate</dt>
          <dd>
            {PLATE_TYPES.find((plate) => plate.id === settings.plateType)?.label}, {settings.bedTemperature} °C
          </dd>
        </div>
      </dl>

      <div className="ticket-checks">
        <h3 className="ticket-h">
          {preflight.ok
            ? warnings.length
              ? `Safe to print, ${warnings.length === 1 ? 'one note' : `${warnings.length} notes`}`
              : 'All safety checks passed'
            : `${failing.length} safety ${failing.length === 1 ? 'check' : 'checks'} failed`}
        </h3>
        <ul className="checklist">
          {preflight.checks.map((check) => (
            <li key={check.id} data-status={check.status} title={check.detail}>
              <span className="check-mark" aria-hidden="true">
                {check.status === 'pass' ? <IconCheck size={12} /> : check.status === 'warn' ? <IconWarn size={12} /> : <IconClose size={12} />}
              </span>
              <span className="check-text">
                {check.label}
                {check.detail && check.status !== 'pass' && <span className="check-detail">{check.detail}</span>}
              </span>
              <span className="sr-only">{check.status === 'pass' ? 'passed' : check.status === 'warn' ? 'note' : 'failed'}</span>
            </li>
          ))}
        </ul>
      </div>

      <button
        type="button"
        className="btn ticket-download"
        data-variant="primary"
        disabled={!preflight.ok || !slice.archive}
        onClick={downloadSlice}
      >
        <IconDownload size={15} />
        Download .gcode.3mf
      </button>
      {!preflight.ok && <p className="ticket-locked">Download stays locked until every check passes.</p>}

      {preflight.ok && (
        <details className="ticket-first">
          <summary>Before the first print</summary>
          <ol>
            <li>Copy the file to the P1S microSD card and start it from the printer screen.</li>
            <li>Check that the plate on the printer is the {PLATE_TYPES.find((p) => p.id === settings.plateType)?.label} and is clean.</li>
            <li>Load {filamentLabel} on the external spool.</li>
            <li>Stay with the printer through the wipe, levelling and the first layer. Stop it if anything looks wrong.</li>
          </ol>
          <p className="note">
            Caliper is a new slicer and its files have not been printed on every model. Machine start and end steps come from
            Bambu&rsquo;s own P1S profile.
          </p>
        </details>
      )}
      <button type="button" className="link-btn" onClick={() => setWorkspace('prepare')}>
        Change settings and slice again
      </button>
    </section>
  );
}

/**
 * A print file opened for preview. Its figures are the ones its slicer wrote
 * in the header; Caliper did not make the file, so it does not vouch for it.
 */
function ImportedTicket() {
  const imported = useViewer((s) => s.slice.imported);
  const setWorkspace = useViewer((s) => s.setWorkspace);
  if (!imported) return null;
  const time = imported.printSeconds ?? imported.totalSeconds;
  return (
    <section className="ticket" aria-label="Print file">
      <header className="ticket-head">
        <span className="ticket-time num">{time !== null ? formatDuration(time) : 'Print file'}</span>
        <span className="ticket-sub">
          {time !== null
            ? imported.totalSeconds !== null && imported.printSeconds !== null && imported.totalSeconds > imported.printSeconds
              ? `of printing, ${formatDuration(imported.totalSeconds)} in total, as its slicer estimated`
              : 'as its slicer estimated'
            : 'The file does not say how long it takes.'}
        </span>
      </header>
      <dl className="ticket-facts">
        <div>
          <dt>File</dt>
          <dd className="ticket-file">{imported.fileName}</dd>
        </div>
        <div>
          <dt>Sliced by</dt>
          <dd>{imported.generator ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Filament</dt>
          <dd className="num">
            {imported.filamentGrams !== null ? `${imported.filamentGrams.toFixed(2)} g` : 'Not stated'}
            {imported.filamentMm !== null ? `, ${(imported.filamentMm / 1000).toFixed(2)} m` : ''}
          </dd>
        </div>
        <div>
          <dt>Layers</dt>
          <dd className="num">
            {imported.layers.toLocaleString()}, up to {imported.maxZ.toFixed(2)} mm
          </dd>
        </div>
      </dl>
      <p className="note">
        Preview only. Caliper did not slice this file, so it has not run its safety checks on it. Send it to the printer
        from the slicer that made it.
      </p>
      <button type="button" className="link-btn" onClick={() => setWorkspace('home')}>
        Open a model to slice instead
      </button>
    </section>
  );
}

/** Preview legend once toolpaths are shown: what each colour is. */
export function FeatureLegend() {
  const present = useViewer((s) => s.slice.features);
  if (!present.length) return null;
  return (
    <div className="legend" aria-label="Toolpath colours">
      {legendOrder(present).map((feature) => (
        <div className="legend-row" key={feature}>
          <i style={{ background: featureColor(feature) }} />
          {feature}
        </div>
      ))}
    </div>
  );
}
