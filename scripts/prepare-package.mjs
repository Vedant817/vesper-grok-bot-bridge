import { copyFile } from 'node:fs/promises';
// npm excludes package-lock.json from archives. Ship the exact tested lock under
// a distinct filename so the managed installer can still use npm ci.
await copyFile(new URL('../package-lock.json', import.meta.url), new URL('../runtime-lock.json', import.meta.url));
