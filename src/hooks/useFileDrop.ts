import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Window-wide drag target. Folder drops are walked recursively so a glTF and
 * its texture directory can be dragged in as one unit.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFiles);
  handler.current = onFiles;

  const readEntry = useCallback(
    async (entry: FileSystemEntry, path: string, out: File[]): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        );
        try {
          Object.defineProperty(file, 'webkitRelativePath', { value: path + file.name });
        } catch {
          /* Already defined by the browser; the plain name is enough. */
        }
        out.push(file);
        return;
      }
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([])),
      );
      for (const child of entries) await readEntry(child, `${path}${entry.name}/`, out);
    },
    [],
  );

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);

      const items = Array.from(e.dataTransfer.items ?? []);
      const entries = items
        .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
        .filter(Boolean) as FileSystemEntry[];

      if (entries.length) {
        const out: File[] = [];
        for (const entry of entries) await readEntry(entry, '', out);
        if (out.length) {
          handler.current(out);
          return;
        }
      }
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length) handler.current(files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [readEntry]);

  return dragging;
}
