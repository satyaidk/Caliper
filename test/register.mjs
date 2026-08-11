import { register } from 'node:module';

// Loaded via `node --import ./test/register.mjs` so the alias hook is installed
// before any test module is resolved.
register('./alias-hook.mjs', import.meta.url);
