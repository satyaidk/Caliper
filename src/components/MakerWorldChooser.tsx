import { useEffect, useRef, useState } from 'react';
import {
  fetchMakerWorldDesign,
  makerWorldProfileUrl,
  type MakerWorldImage,
  type MakerWorldDesign,
  type MakerWorldTarget,
} from '@/lib/makerworld';
import { IconClose } from './Icons';

function readableSize(size: number | null): string {
  if (size === null) return '';
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function MakerWorldChooser({
  target,
  onClose,
}: {
  target: MakerWorldTarget;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [design, setDesign] = useState<MakerWorldDesign | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeImage, setActiveImage] = useState<MakerWorldImage | null>(null);
  const [format, setFormat] = useState<'3mf' | 'stl'>('3mf');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void fetchMakerWorldDesign(target, fetch, controller.signal)
      .then((result) => {
        setDesign(result);
        const preferred = result.profiles.find((profile) => profile.profileId === target.requestedProfileId);
        setSelected(preferred?.instanceId ?? result.profiles.find((profile) => profile.isDefault)?.instanceId ?? result.profiles[0]?.instanceId ?? null);
        setSelectedFile(result.files.find((file) => file.extension === 'stl' && !file.protected)?.id ?? null);
        setActiveImage(result.images[0] ?? (result.coverUrl ? { url: result.coverUrl, label: 'Model cover' } : null));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'MakerWorld model details could not be loaded.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [target]);

  const profile = design?.profiles.find((item) => item.instanceId === selected);
  const stlFiles = design?.files.filter((file) => file.extension === 'stl') ?? [];
  const canDownloadStl = stlFiles.some((file) => !file.protected);
  const chosenFile = design?.files.find((file) => file.id === selectedFile) ?? null;
  const pageUrl = design && profile ? makerWorldProfileUrl(design, profile) : target.pageUrl;
  const close = () => {
    dialog.current?.close();
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className="dialog makerworld-dialog"
      aria-labelledby="makerworld-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <header className="dialog-head makerworld-head">
        <h2 id="makerworld-title">
          <span>MakerWorld</span>
          {design && <small>Model {design.designId}</small>}
        </h2>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close">
          <IconClose />
        </button>
      </header>
      <div className="dialog-body makerworld-body">
        {loading && <p className="makerworld-status" role="status">Loading model details and previews…</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
        {design && (
          <>
            <div className="makerworld-title-row">
              <h3 className="makerworld-name">{design.title}</h3>
              <p className="makerworld-subtitle">
                {design.profiles.length} {design.profiles.length === 1 ? 'profile' : 'profiles'}
                {stlFiles.length ? ` · ${stlFiles.length} STL files` : ''}
              </p>
            </div>
            <div className="makerworld-layout">
              <section className="makerworld-gallery" aria-label="Model reference images">
                <div className="makerworld-preview">
                  {activeImage ? (
                    <img src={activeImage.url} alt={activeImage.label} referrerPolicy="no-referrer" />
                  ) : (
                    <div className="makerworld-no-preview">No preview image available</div>
                  )}
                  {activeImage && <span>{activeImage.label}</span>}
                </div>
                <p className="makerworld-preview-note">
                  Caliper can show MakerWorld’s public images, but its preview mesh requires an authenticated
                  MakerWorld request.{' '}
                  <a href={pageUrl} target="_blank" rel="noopener noreferrer">Open the interactive preview on MakerWorld</a>
                  .
                </p>
                {design.images.length > 1 && (
                  <div className="makerworld-thumbnails" aria-label="Choose a reference image">
                    {design.images.map((image) => (
                      <button
                        type="button"
                        key={image.url}
                        className="makerworld-thumbnail"
                        data-selected={activeImage?.url === image.url}
                        aria-label={`Show ${image.label}`}
                        aria-pressed={activeImage?.url === image.url}
                        onClick={() => setActiveImage(image)}
                      >
                        <img src={image.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <section className="makerworld-choices" aria-label="Download choices">
                <fieldset className="makerworld-options">
                  <legend>1 · Choose a print profile</legend>
                  <div className="makerworld-profile-list">
                    {design.profiles.map((item) => (
                      <label className="makerworld-profile" key={item.instanceId} data-selected={selected === item.instanceId}>
                        <input
                          type="radio"
                          name="makerworld-profile"
                          value={item.instanceId}
                          checked={selected === item.instanceId}
                          onChange={() => {
                            setSelected(item.instanceId);
                            if (item.previewUrl) setActiveImage({ url: item.previewUrl, label: item.title });
                          }}
                        />
                        {item.previewUrl && <img src={item.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                        <span>{item.title}</span>
                        {item.isDefault && <small>Default</small>}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {stlFiles.length > 0 && (
                  <fieldset className="makerworld-options">
                    <legend>2 · Choose a model file for STL</legend>
                    <div className="makerworld-file-list">
                      {stlFiles.map((file) => (
                        <label className="makerworld-file" key={file.id} data-selected={selectedFile === file.id}>
                          <input
                            type="radio"
                            name="makerworld-file"
                            value={file.id}
                            checked={selectedFile === file.id}
                            disabled={file.protected}
                            onChange={() => {
                              setSelectedFile(file.id);
                              if (file.thumbnailUrl) setActiveImage({ url: file.thumbnailUrl, label: file.name });
                            }}
                          />
                          {file.thumbnailUrl ? (
                            <img src={file.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <span className="makerworld-file-icon">STL</span>
                          )}
                          <span className="makerworld-file-name">
                            <b>{file.name}</b>
                            <small>{file.protected ? 'Creator protected' : readableSize(file.sizeBytes)}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
                <fieldset className="makerworld-options makerworld-formats">
                  <legend>3 · Choose download format</legend>
                  <label className="makerworld-format" data-selected={format === '3mf'}>
                    <input type="radio" name="makerworld-format" checked={format === '3mf'} onChange={() => setFormat('3mf')} />
                    <span><b>3MF</b><small>Complete print profile and plate</small></span>
                  </label>
                  <label className="makerworld-format" data-selected={format === 'stl'} aria-disabled={!canDownloadStl}>
                    <input
                      type="radio"
                      name="makerworld-format"
                      checked={format === 'stl'}
                      disabled={!canDownloadStl}
                      onChange={() => setFormat('stl')}
                    />
                    <span>
                      <b>STL</b>
                      <small>{canDownloadStl ? chosenFile?.name ?? 'Individual model file' : 'No public STL files available'}</small>
                    </span>
                  </label>
                </fieldset>
              </section>
            </div>
            <footer className="makerworld-footer">
              <p className="makerworld-note">
                MakerWorld handles the file download and may ask you to sign in. The selected {format.toUpperCase()}
                {format === 'stl' && chosenFile ? ` is ${chosenFile.name}.` : ' includes the selected print profile.'}
                {' '}Caliper shows MakerWorld's public file previews; continue there to download the actual model, then open it in Caliper.
              </p>
              <a className="btn makerworld-continue" href={pageUrl} target="_blank" rel="noopener noreferrer">
                Open selected profile on MakerWorld
              </a>
            </footer>
          </>
        )}
      </div>
    </dialog>
  );
}
