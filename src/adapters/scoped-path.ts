import { dirname, resolve } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { within } from '../safety.js';

/** Check existing ancestors too, so a lexical child through a symlink is rejected. */
export function scopedPath(cwd: string, path: unknown): boolean {
  if (typeof path !== 'string' || !path || path.includes('\0')) return false;
  const candidate = resolve(cwd, path); if (!within(cwd, candidate)) return false;
  let parent = candidate;
  for (;;) {
    try { return within(realpathSync(cwd), realpathSync(parent)); }
    catch {
      // A dangling link exists even when realpath reports ENOENT. Never climb
      // past it and mistake its target for a nonexistent ordinary child.
      try { lstatSync(parent); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
      const next = dirname(parent); if (next === parent) return false; parent = next;
    }
  }
}
