import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Muster was first called "Session desk" and used META_* settings and ~/.local/share/meta-agent. Those still
// work: old settings are copied to their MUSTER_* names at startup, and an existing old data folder is kept.

/** Copies each META_* setting to its MUSTER_* name unless that is already set. */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('META_') || value === undefined) continue;
    const name = 'MUSTER_' + key.slice(5);
    if (env[name] === undefined) env[name] = value;
  }
}

/** The data folder: MUSTER_DATA_DIR, else ~/.local/share/muster, unless only the old folder exists. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, home = env.HOME || os.homedir()) {
  if (env.MUSTER_DATA_DIR) return path.resolve(env.MUSTER_DATA_DIR);
  const current = path.join(home, '.local/share/muster');
  const legacy = path.join(home, '.local/share/meta-agent');
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
