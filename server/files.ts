import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {structuredPatch} from 'diff';
import os from 'node:os';
import path from 'node:path';
import {DATA} from './security.js';

/** A desktop file the agent made or shared in a thread, viewable in the app. */
export type SharedFile = {
  id: string;
  path: string;
  name: string;
  size: number;
  mtime: number;
  added: number;
  via: 'write' | 'edit' | 'share';
  /** 'change': code the agent edited or created. 'artifact': a report, export, image or other output. */
  kind?: 'change' | 'artifact';
  /** The file did not exist before this thread wrote it. */
  created?: boolean;
  /** Lines added and removed since the thread first touched the file, when a baseline was saved. */
  linesAdded?: number;
  linesRemoved?: number;
};

/** Largest file kept as a "before" version or diffed; bigger and binary files get no diff. */
export const MAX_DIFF_BYTES = 1024 * 1024;

const CODE = new RegExp(
  '\\.(sh|bash|zsh|fish|py|rb|php|js|mjs|cjs|ts|mts|cts|tsx|jsx|vue|svelte|css|scss|less|go|rs|java|kt|kts|scala|swift|' +
    'c|h|cc|cpp|hpp|cs|m|mm|lua|pl|r|sql|graphql|gql|proto|tf|hcl|ya?ml|toml|ini|cfg|conf|env\\.example|json|jsonc|' +
    'xml|gradle|cmake|mk|dockerfile|nix|ex|exs|erl|dart|zig|ps1|bat)$|(^|/)(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|' +
    'Justfile|\\.gitignore|\\.dockerignore|\\.editorconfig)$',
  'i',
);

/**
 * Edits and changes to existing files are code changes. New files are code when they look like source or
 * config; reports, notes, exports and images are artifacts, as is anything shared with share_file.
 */
export function fileKind(name: string, via: SharedFile['via'], created: boolean | undefined): 'change' | 'artifact' {
  if (via === 'share') return 'artifact';
  if (via === 'edit' || created === false) return 'change';
  return CODE.test(name) ? 'change' : 'artifact';
}

/** Text content for diffing, or undefined for missing, large or binary files. */
export function readText(file: string) {
  if (!existsSync(file)) return undefined;
  if (statSync(file).size > MAX_DIFF_BYTES) return undefined;
  const buffer = readFileSync(file);
  if (buffer.includes(0)) return undefined;
  return buffer.toString('utf8');
}

/** Unified diff between two versions, with counts. */
export function diffText(name: string, before: string, after: string, context = 4) {
  const patch = structuredPatch(name, name, before, after, '', '', {context});
  let added = 0;
  let removed = 0;
  const lines = [`--- ${before ? 'a/' + name : '/dev/null'}`, `+++ b/${name}`];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
      lines.push(line);
    }
  }
  return {patch: lines.join('\n') + '\n', added, removed};
}

export const MAX_SHARED_BYTES = 200 * 1024 * 1024;
export const MAX_SHARED_FILES = 200;

// Credentials and key material are never served, even when the agent asks.
const SECRET = [
  /\/\.ssh\//,
  /\/\.gnupg\//,
  /\/\.aws\//,
  /\/\.azure\//,
  /\/\.kube\//,
  /\/\.cloudflared\//,
  /\/\.docker\/config\.json$/,
  /\/\.config\/(gcloud|gh|op)\//,
  /\/\.pi\/agent\/auth\.json$/,
  /\/\.claude\/\.credentials\.json$/,
  /\/\.codex\/auth\.json$/,
  /\/Library\/Keychains\//,
  /\/Library\/Cookies\//,
  /\/\.env(\.[^/]*)?$/,
  /\/\.(netrc|npmrc|pypirc|git-credentials|pgpass)$/,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn)$/i,
  /\/id_(rsa|dsa|ecdsa|ed25519)[^/]*$/,
  /\/[^/]*(secret|credential|password)[^/]*$/i,
];

const real = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

/** Folders a thread may share from: its working folder and the temp folders. */
export function shareRoots(cwd: string) {
  return [...new Set([cwd, os.tmpdir(), '/tmp'].map(real))];
}

const inside = (file: string, root: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Resolves and checks a file before it is listed or served. Throws a short reason when it may not be. */
export function checkShareable(file: string, roots: string[]) {
  if (!path.isAbsolute(file)) throw new Error('Use an absolute path.');
  let resolved: string;
  try {
    resolved = realpathSync(file);
  } catch {
    throw new Error('File not found.');
  }
  for (const candidate of [file, resolved]) {
    if (SECRET.some(pattern => pattern.test(candidate))) throw new Error('Credential and key files cannot be shared.');
    if (inside(candidate, real(DATA))) throw new Error("The app's own data cannot be shared.");
  }
  if (!roots.some(root => inside(resolved, root))) throw new Error("Only files inside the thread's folder or /tmp can be shared.");
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error('Only regular files can be shared.');
  if (stat.size > MAX_SHARED_BYTES) throw new Error('Files over 200 MB cannot be shared.');
  return {path: resolved, size: stat.size, mtime: stat.mtimeMs};
}

/**
 * Checks a path that may not exist yet (a file the agent is about to create): its folder must be shareable
 * and its name must not be credential material. Returns the resolved path.
 */
export function checkWritable(file: string, roots: string[]) {
  if (!path.isAbsolute(file)) throw new Error('Use an absolute path.');
  if (existsSync(file)) return checkShareable(file, roots).path;
  let folder = path.dirname(file);
  while (!existsSync(folder) && folder !== path.dirname(folder)) folder = path.dirname(folder);
  const resolved = path.join(real(folder), path.relative(folder, file));
  if (SECRET.some(pattern => pattern.test(resolved))) throw new Error('Credential and key files cannot be shared.');
  if (inside(resolved, real(DATA))) throw new Error("The app's own data cannot be shared.");
  if (!roots.some(root => inside(resolved, root))) throw new Error("Only files inside the thread's folder or /tmp can be shared.");
  return resolved;
}

/** Types a browser would run as a page; they are served in a sandbox with no access to the app. */
export const ACTIVE_CONTENT = /\.(html?|xhtml|svg|xml|xsl)$/i;
