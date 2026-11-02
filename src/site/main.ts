import '../styles/tokens.css';
import '../styles/base.css';
import './site.css';
import { FORMATS } from '@/lib/formats';
import { dim } from '@/lib/format';
import { spreadLabels } from '@/lib/labels';
import { registerServiceWorker } from '@/pwa/register';
import type { RenderMode } from '@/types';

/**
 * The website. Plain TypeScript, no React: it is a document with one live
 * element in it, and that element is the app's own Engine, loaded after the
 * page has painted so the words never wait on three.js.
 *
 * Every number on the page that describes the product is computed here from
 * the same modules the app uses — the format count from the format registry,
 * the part's size from the Engine — so the page cannot advertise something the
 * app does not do.
 */

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector);

/* --- theme ---------------------------------------------------------------- */

function setTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('caliper.theme', theme);
  } catch {
    /* storage can be off; the toggle still works for this visit */
  }
  window.dispatchEvent(new CustomEvent('caliper-theme', { detail: theme }));
}

$('#theme-toggle')?.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

/* --- counts --------------------------------------------------------------- */

const NAMED_IN_LEDE = 3; // STL, STEP and 3MF
document.querySelectorAll('[data-count]').forEach((node) => (node.textContent = String(FORMATS.length)));
document
  .querySelectorAll('[data-count-rest]')
  .forEach((node) => (node.textContent = String(FORMATS.length - NAMED_IN_LEDE)));

/* --- install -------------------------------------------------------------- */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

const installButton = $<HTMLButtonElement>('#install-button');
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  if (!installButton) return;
  installButton.hidden = false;
  installButton.onclick = () => {
    installButton.hidden = true;
    void (event as InstallPromptEvent).prompt();
  };
});
window.addEventListener('appinstalled', () => {
  if (installButton) installButton.hidden = true;
  const note = $('#install-note');
  if (note) note.textContent = 'Installed. Caliper is in your apps list, and model files can be opened with it.';
});

registerServiceWorker();

/* --- the live hero -------------------------------------------------------- */

async function startHero() {
  const canvas = $<HTMLCanvasElement>('#hero-canvas');
  const stage = $<HTMLElement>('#hero-stage');
  const tags = $<HTMLElement>('#hero-tags');
  if (!canvas || !stage || !tags) return;

  const { hasWebGL } = await import('@/lib/webgl');
  if (!hasWebGL()) {
    stage.classList.add('is-static');
    $<HTMLImageElement>('.hero-fallback')?.removeAttribute('hidden');
    return;
  }

  const [{ Engine }, sample, THREE] = await Promise.all([
    import('@/viewer/Engine'),
    import('@/lib/sample'),
    import('three'),
  ]);

  const engine = new Engine(canvas);
  // The orbit controls claim every touch; on a page that scrolls, a vertical
  // swipe over the hero has to scroll the page instead. Sideways still turns it.
  canvas.style.touchAction = 'pan-y';
  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  engine.setTheme(theme());
  window.addEventListener('caliper-theme', () => engine.setTheme(theme()));

  const mesh = new THREE.Mesh(sample.gearGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'Spur gear';
  engine.setFilament('#00ae42', false);
  engine.setModel(mesh, false);
  engine.setPlate(null);
  engine.setRenderMode('shaded');

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  engine.configureControls({ zoom: false, autoRotate: reduced ? 0 : 1.1 });

  const d = engine.dimensions();
  for (const axis of ['x', 'y', 'z'] as const) {
    const node = document.querySelector(`[data-dim="${axis}"]`);
    if (node) node.textContent = dim(d[axis], 'mm');
  }

  const points = sample.gearReferencePoints();
  const measured = [
    engine.addMeasurement('diameter', points.tips),
    engine.addMeasurement('distance', points.thickness),
  ].filter((m) => m !== null);

  tags.innerHTML = measured
    .map(
      (m) =>
        `<span class="hero-tag num" data-id="${m.id}">${m.tool === 'diameter' ? 'Ø ' : ''}${dim(m.value, 'mm')}</span>`,
    )
    .join('');
  const nodes = new Map<number, HTMLElement>();
  tags.querySelectorAll<HTMLElement>('[data-id]').forEach((n) => nodes.set(Number(n.dataset.id), n));
  engine.setLabelSink((anchors) => {
    for (const anchor of spreadLabels(anchors)) {
      const node = nodes.get(anchor.id);
      if (!node) continue;
      node.style.transform = `translate(-50%, -50%) translate(${anchor.x}px, ${anchor.y}px)`;
      node.style.visibility = anchor.behind ? 'hidden' : 'visible';
    }
  });

  const resize = () => engine.resize();
  new ResizeObserver(resize).observe(stage);
  resize();
  engine.setView('iso');

  // The demo toolbar drives the real engine, one switch per button.
  const toolbar = stage.querySelector('.hero-toolbar');
  toolbar?.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      engine.setRenderMode(button.dataset.mode as RenderMode);
      toolbar
        .querySelectorAll<HTMLButtonElement>('[data-mode]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    });
  });
  toolbar?.querySelector<HTMLButtonElement>('[data-toggle="section"]')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(on));
    engine.setClip(on ? { axis: 'z', at: 0.5, flip: false } : null);
  });
  toolbar?.querySelector<HTMLButtonElement>('[data-toggle="ortho"]')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(on));
    engine.setProjection(on ? 'orthographic' : 'perspective');
  });

  // Off screen, the hero stops drawing.
  new IntersectionObserver(([entry]) => engine.setPaused(!entry.isIntersecting)).observe(stage);
  stage.classList.add('is-live');
}

// After first paint, so the words are never held up by three.js.
if ('requestIdleCallback' in window) window.requestIdleCallback(() => void startHero(), { timeout: 1200 });
else setTimeout(() => void startHero(), 200);
