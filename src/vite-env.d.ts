/// <reference types="vite/client" />

/**
 * The File Handling API, which hands an installed PWA the files the OS was
 * asked to open. Not in lib.dom yet, and only Chromium ships it — App.tsx
 * feature-detects before touching any of this.
 */
interface LaunchParams {
  files?: FileSystemFileHandle[];
  targetURL?: string;
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

interface Window {
  launchQueue?: LaunchQueue;
}
