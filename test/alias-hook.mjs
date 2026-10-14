import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Makes Node resolve imports the way Vite does, so tests can import application
 * modules exactly as the application writes them.
 *
 * Two things a bundler does that Node's ESM resolver does not:
 *
 *   1. the `@/` alias declared in vite.config.ts and tsconfig.json
 *   2. extensionless imports — `./mesh` meaning `./mesh.ts`
 *
 * Twenty lines instead of a test-framework dependency.
 */

const SRC = new URL('../src/', import.meta.url);
const SUFFIXES = ['', '.ts', '.tsx', '.js', '/index.ts'];

const isFile = (url) => {
  try {
    return fs.statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
};

export async function resolve(specifier, context, next) {
  const aliased = specifier.startsWith('@/')
    ? new URL(specifier.slice(2), SRC).href
    : specifier;

  // Bare specifiers (`three`, `node:test`) are Node's own business.
  const relative = aliased.startsWith('.') || aliased.startsWith('file:');
  if (!relative) return next(aliased, context);

  const base = new URL(aliased, context.parentURL);
  for (const suffix of SUFFIXES) {
    const candidate = new URL(base.href + suffix);
    if (isFile(candidate)) return next(candidate.href, context);
  }
  return next(aliased, context);
}
