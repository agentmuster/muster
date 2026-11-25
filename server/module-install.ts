import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import {writePrivate} from './account.js';
import {loadManifest, type Manifest, type Modules} from './modules.js';

// Installing modules from a module repository (a git repo with registry.json, such as muster-modules), from any git
// URL, or from a local folder. Every install is staged first and shown to the owner with what the module can reach;
// only a confirmed, unchanged stage is moved into place. Dependencies install with npm's install scripts off, so no
// third-party code runs until the owner turns the module on. The previous version is kept for a one-step rollback.

const ROOT = path.resolve(import.meta.dirname, '..');
export const SDK_DIR = path.join(ROOT, 'packages', 'module-sdk');
export const OFFICIAL_REGISTRY = 'https://github.com/agentmuster/muster-modules';
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const STAGE_TTL_MS = 15 * 60_000;
const REGISTRY_TTL_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 120_000;
const NPM_TIMEOUT_MS = 5 * 60_000;
const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const SKIP = new Set(['node_modules', '.git']);

export type RegistryEntry = {id: string; name: string; description: string; version: string; path: string; categories: string[]};
export type Registry = {url: string; official: boolean; commit?: string; fetchedAt?: number; error?: string; modules: RegistryEntry[]};
export type Source =
  | {kind: 'registry'; url: string; path: string; commit: string}
  | {kind: 'git'; url: string; ref?: string; path: string; commit: string}
  | {kind: 'folder'; path: string};
export type LockEntry = {id: string; version: string; source: Source; hash: string; installedAt: number; reviewed: boolean; previous?: Omit<LockEntry, 'previous'>};
export type InstallRequest = {registry?: unknown; id?: unknown; refresh?: unknown; git?: unknown; ref?: unknown; path?: unknown; folder?: unknown};

/** What a module can reach and do, shown before it is installed. */
export function permissions(manifest: Manifest) {
  return {
    network: [...manifest.network],
    connectors: [...manifest.connectors],
    tools: manifest.tools.map(tool => tool.name),
    feeds: manifest.feeds.map(feed => feed.title),
    actions: manifest.actions.map(action => action.title + (action.confirm === 'never' ? ' (runs without confirmation)' : '')),
    providers: manifest.providers.pullRequests ? ['Pull requests: review and merge'] : [],
    secrets: manifest.settings.filter(field => field.type === 'secret').map(field => field.label),
  };
}
export type Permissions = ReturnType<typeof permissions>;

/** Entries in next that current lacks: what an update would add. */
function added(next: Permissions, current: Permissions): Permissions {
  const out = {} as Permissions;
  for (const key of Object.keys(next) as (keyof Permissions)[]) out[key] = next[key].filter(item => !current[key].includes(item));
  return out;
}

/** a > b for dotted versions; non-numeric parts compare as text. */
export function newerVersion(a: string, b: string) {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) return nx > ny;
    return x > y;
  }
  return false;
}

/** https URLs and local file:// URLs only; never ssh, ext:: or other git transports. */
export function checkGitUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 500 || value.startsWith('-') || value.includes('::')) throw new Error('Give an https git URL.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Give an https git URL.');
  }
  if (url.username || url.password) throw new Error('Leave credentials out of the URL; git uses the ones on this desktop.');
  if (url.protocol === 'https:' && url.hostname) return url.href.replace(/\/+$/, '');
  if (url.protocol === 'file:' && !url.host && path.isAbsolute(decodeURIComponent(url.pathname)) && url.pathname !== '/') return url.href;
  throw new Error('Give an https git URL.');
}

/** A path inside a repository, without .. or a leading slash. */
function checkRelative(value: unknown) {
  const text = typeof value === 'string' ? value.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '') : '';
  if (text.split('/').some(part => part === '..' || part === '.git') || text.length > 300) throw new Error('Invalid folder inside the repository.');
  return text;
}

/** Every file of a module folder, sorted; refuses symlinks and oversized folders. */
function files(dir: string) {
  const out: string[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      if (SKIP.has(name)) continue;
      const relative = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path.join(dir, relative));
      if (stat.isSymbolicLink()) throw new Error(`The module contains a symbolic link (${relative}), which Muster does not install.`);
      if (stat.isDirectory()) walk(relative);
      else if (stat.isFile()) {
        out.push(relative);
        bytes += stat.size;
        if (out.length > MAX_FILES || bytes > MAX_BYTES) throw new Error('The module folder is too large to install.');
      }
    }
  };
  walk('');
  return out;
}

/** A hash of the module's files (not its installed dependencies), recorded in the lockfile. */
export function treeHash(dir: string) {
  const hash = createHash('sha256');
  for (const file of files(dir)) {
    hash.update(file + '\0');
    hash.update(readFileSync(path.join(dir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function run(command: string, args: string[], cwd: string, timeout: number) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      {cwd, timeout, maxBuffer: 8_000_000, env: {...process.env, GIT_TERMINAL_PROMPT: '0', npm_config_ignore_scripts: 'true'}},
      (error, stdout, stderr) => {
        if (error) {
          const reason = String(stderr || error.message).trim().split('\n').filter(Boolean).slice(-2).join(' ');
          reject(new Error(reason.slice(0, 400) || `${command} failed`));
        } else resolve(String(stdout));
      },
    );
  });
}

type Staged = {
  dir: string;
  manifest: Manifest;
  source: Source;
  hash: string;
  reviewed: boolean;
  expires: number;
};

export class ModuleInstaller {
  readonly lockFile: string;
  private cacheDir: string;
  private registriesFile: string;
  private staged = new Map<string, Staged>();
  private queue: Promise<unknown> = Promise.resolve();
  private seenLock = 0;

  constructor(
    private modules: Modules,
    readonly home: string,
    state: string,
    readonly registryUrls: string[] = [OFFICIAL_REGISTRY],
    private bins = {git: process.env.MUSTER_GIT_BIN || 'git', npm: process.env.MUSTER_NPM_BIN || 'npm'},
  ) {
    this.lockFile = path.join(state, 'modules.lock.json');
    this.cacheDir = path.join(state, 'registry-cache');
    this.registriesFile = path.join(state, 'registries.json');
  }

  get disabled() {
    return process.env.MUSTER_MODULE_INSTALL_DISABLED === '1';
  }

  private assertEnabled() {
    if (this.disabled) throw new Error('Installing modules is turned off on this desktop (MUSTER_MODULE_INSTALL_DISABLED).');
  }

  /** One change at a time, so two installs cannot race on the same folder or the lockfile. */
  private serial<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  lock(): Record<string, LockEntry> {
    try {
      return JSON.parse(readFileSync(this.lockFile, 'utf8'));
    } catch {
      return {};
    }
  }

  private saveLock(lock: Record<string, LockEntry>) {
    mkdirSync(path.dirname(this.lockFile), {recursive: true, mode: 0o700});
    writePrivate(this.lockFile, JSON.stringify(lock, null, 2));
    this.seenLock = statSync(this.lockFile).mtimeMs;
  }

  /** Reloads manifests when another process, such as the CLI, changed the installed modules. */
  syncFromDisk() {
    try {
      const mtime = statSync(this.lockFile).mtimeMs;
      if (mtime !== this.seenLock) {
        this.seenLock = mtime;
        this.modules.reload();
      }
    } catch {
      // No lockfile yet.
    }
  }

  /**
   * Installed modules import "@agentmuster/module-sdk"; this links the SDK of the running Muster into the modules
   * folder, so it always matches the host that runs the module.
   */
  ensureSdkLink() {
    const scope = path.join(this.home, 'node_modules', '@agentmuster');
    const link = path.join(scope, 'module-sdk');
    mkdirSync(scope, {recursive: true, mode: 0o700});
    try {
      const stat = lstatSync(link);
      if (!stat.isSymbolicLink()) return;
      if (readlinkSync(link) === SDK_DIR) return;
      unlinkSync(link);
    } catch {
      // Not there yet.
    }
    symlinkSync(SDK_DIR, link, 'dir');
  }

  // Registries

  private registryCache(): Record<string, Registry> {
    try {
      return JSON.parse(readFileSync(this.registriesFile, 'utf8'));
    } catch {
      return {};
    }
  }

  private checkout(url: string) {
    return path.join(this.cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 16));
  }

  /** Clones a repository's default branch (or ref) into a new folder and returns the folder and commit. */
  private async clone(url: string, into: string, ref?: string) {
    mkdirSync(path.dirname(into), {recursive: true, mode: 0o700});
    rmSync(into, {recursive: true, force: true});
    await run(this.bins.git, ['clone', '--quiet', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, into], path.dirname(into), GIT_TIMEOUT_MS);
    const commit = (await run(this.bins.git, ['rev-parse', 'HEAD'], into, GIT_TIMEOUT_MS)).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Could not read the repository commit.');
    return commit;
  }

  private async fetchRegistry(url: string): Promise<Registry> {
    const official = url === OFFICIAL_REGISTRY;
    const target = this.checkout(url);
    const temp = `${target}.${randomUUID()}`;
    try {
      const commit = await this.clone(url, temp);
      const raw = JSON.parse(readFileSync(path.join(temp, 'registry.json'), 'utf8'));
      if (raw?.format !== 1 || !Array.isArray(raw.modules)) throw new Error('registry.json is not a Muster module registry.');
      const modules: RegistryEntry[] = [];
      for (const entry of raw.modules) {
        if (!entry || !ID.test(entry.id) || typeof entry.path !== 'string') continue;
        let folder: string;
        try {
          folder = checkRelative(entry.path);
        } catch {
          // An entry pointing outside the repository is skipped; the rest still list.
          continue;
        }
        modules.push({
          id: entry.id,
          name: String(entry.name ?? entry.id).slice(0, 100),
          description: String(entry.description ?? '').slice(0, 500),
          version: String(entry.version ?? '').slice(0, 40),
          path: folder,
          categories: Array.isArray(entry.categories) ? entry.categories.map(String).slice(0, 5) : [],
        });
      }
      rmSync(target, {recursive: true, force: true});
      renameSync(temp, target);
      return {url, official, commit, fetchedAt: Date.now(), modules};
    } catch (error: any) {
      rmSync(temp, {recursive: true, force: true});
      return {url, official, fetchedAt: Date.now(), error: String(error.message).slice(0, 400), modules: []};
    }
  }

  /** The module repositories and their modules, refreshed when older than 15 minutes or when asked. */
  async registries(refresh = false) {
    const cache = this.registryCache();
    const out: Registry[] = [];
    let changed = false;
    for (const url of this.registryUrls) {
      const cached = cache[url];
      const fresh = cached?.fetchedAt && Date.now() - cached.fetchedAt < REGISTRY_TTL_MS && existsSync(this.checkout(url));
      if (cached && fresh && !refresh && !cached.error) out.push(cached);
      else {
        const next = await this.fetchRegistry(url);
        // A failed refresh keeps the last good list, with the error shown.
        const kept = next.error && cached?.commit ? {...cached, error: next.error} : next;
        cache[url] = kept;
        out.push(kept);
        changed = true;
      }
    }
    if (changed) {
      mkdirSync(path.dirname(this.registriesFile), {recursive: true, mode: 0o700});
      writePrivate(this.registriesFile, JSON.stringify(cache, null, 2));
    }
    return out;
  }

  /** The registries with each module's installed version and whether an update is out. */
  async browse(refresh = false) {
    const lock = this.lock();
    const registries = await this.registries(refresh);
    return {
      disabled: this.disabled,
      registries: registries.map(registry => ({
        ...registry,
        modules: registry.modules.map(entry => {
          const installed = lock[entry.id] ?? (this.modules.manifests.get(entry.id) ? {version: this.modules.manifests.get(entry.id)!.version} : undefined);
          return {
            ...entry,
            installed: installed ? {version: installed.version} : null,
            updateAvailable: !!installed && !!entry.version && newerVersion(entry.version, installed.version),
          };
        }),
      })),
    };
  }

  // Staging and consent

  private cleanStages() {
    for (const [token, stage] of this.staged) {
      if (Date.now() > stage.expires) {
        rmSync(path.dirname(stage.dir), {recursive: true, force: true});
        this.staged.delete(token);
      }
    }
  }

  /** Copies a module folder into a fresh stage after checking it stays inside its source. */
  private copyIn(from: string, within: string) {
    const real = realpathSync(from);
    const base = realpathSync(within);
    if (real !== base && !real.startsWith(base + path.sep)) throw new Error('The module folder is outside its repository.');
    if (!existsSync(path.join(real, 'muster-module.json'))) throw new Error('No muster-module.json in that folder.');
    files(real);
    const stageRoot = path.join(this.home, '.staging', randomUUID());
    const dir = path.join(stageRoot, 'module');
    mkdirSync(stageRoot, {recursive: true, mode: 0o700});
    cpSync(real, dir, {recursive: true, filter: source => !SKIP.has(path.basename(source))});
    return dir;
  }

  /**
   * Fetches and stages a module, then returns what the owner must approve: what it can reach, and for an update
   * what is new. Nothing is installed until install() is called with the returned token.
   */
  preview(request: InstallRequest) {
    this.assertEnabled();
    return this.serial(async () => {
      this.cleanStages();
      let dir: string;
      let source: Source;
      let reviewed = false;
      let expectId: string | undefined;
      if (request.registry !== undefined) {
        const url = checkGitUrl(request.registry);
        if (!this.registryUrls.includes(url)) throw new Error('That module repository is not in the list.');
        let registry = (await this.registries(request.refresh === true)).find(r => r.url === url);
        // A module added since the list was read is found by reading it again.
        if (registry && !registry.modules.some(m => m.id === request.id)) registry = (await this.registries(true)).find(r => r.url === url);
        if (!registry?.commit) throw new Error(registry?.error || 'The module repository could not be read.');
        const entry = registry.modules.find(m => m.id === request.id);
        if (!entry) throw new Error('That module is not in the repository.');
        const checkout = this.checkout(url);
        dir = this.copyIn(path.join(checkout, entry.path), checkout);
        source = {kind: 'registry', url, path: entry.path, commit: registry.commit};
        reviewed = registry.official;
        expectId = entry.id;
      } else if (request.git !== undefined) {
        const url = checkGitUrl(request.git);
        const ref = typeof request.ref === 'string' && request.ref.trim() ? request.ref.trim() : undefined;
        if (ref && !/^[\w./-]{1,100}$/.test(ref)) throw new Error('Invalid branch or tag.');
        const sub = checkRelative(request.path);
        const checkout = path.join(this.home, '.staging', randomUUID() + '-clone');
        try {
          const commit = await this.clone(url, checkout, ref);
          dir = this.copyIn(path.join(checkout, sub), checkout);
          source = {kind: 'git', url, ...(ref ? {ref} : {}), path: sub, commit};
          reviewed = this.registryUrls.includes(url) && url === OFFICIAL_REGISTRY;
        } finally {
          rmSync(checkout, {recursive: true, force: true});
        }
      } else if (typeof request.folder === 'string' && path.isAbsolute(request.folder)) {
        const folder = path.resolve(request.folder);
        dir = this.copyIn(folder, folder);
        source = {kind: 'folder', path: folder};
      } else {
        throw new Error('Choose a module from a repository, or give a git URL or a local folder.');
      }
      const manifest = loadManifest(dir);
      if (!manifest) {
        rmSync(path.dirname(dir), {recursive: true, force: true});
        throw new Error('The module manifest is invalid. See the Muster log for the reason.');
      }
      if (expectId && manifest.id !== expectId) {
        rmSync(path.dirname(dir), {recursive: true, force: true});
        throw new Error(`The repository lists ${expectId}, but its manifest says ${manifest.id}.`);
      }
      const existing = this.modules.manifests.get(manifest.id);
      if (existing && !existing.dir.startsWith(this.home + path.sep)) {
        rmSync(path.dirname(dir), {recursive: true, force: true});
        throw new Error(`A module called ${manifest.id} is already provided by ${existing.dir}.`);
      }
      const token = randomUUID();
      const hash = treeHash(dir);
      this.staged.set(token, {dir, manifest, source, hash, reviewed, expires: Date.now() + STAGE_TTL_MS});
      const now = permissions(manifest);
      const lock = this.lock()[manifest.id];
      return {
        token,
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        source: describeSource(source),
        reviewed,
        permissions: now,
        update: existing ? {from: existing.version, added: added(now, permissions(existing)), sourceChanged: !!lock && sourceKey(lock.source) !== sourceKey(source)} : null,
        dependencies: Object.keys(readJson(path.join(dir, 'package.json'))?.dependencies ?? {}),
      };
    });
  }

  /** Installs a staged module: dependencies with scripts off, then moved into place, keeping the old version. */
  install(token: unknown) {
    this.assertEnabled();
    return this.serial(async () => {
      const stage = typeof token === 'string' ? this.staged.get(token) : undefined;
      if (!stage || Date.now() > stage.expires) throw new Error('Review the module again before installing it.');
      this.staged.delete(token as string);
      const stageRoot = path.dirname(stage.dir);
      try {
        if (treeHash(stage.dir) !== stage.hash) throw new Error('The staged module changed after it was reviewed.');
        const pkg = readJson(path.join(stage.dir, 'package.json'));
        if (pkg?.dependencies && Object.keys(pkg.dependencies).length) {
          const lockfile = existsSync(path.join(stage.dir, 'package-lock.json'));
          const args = [
            lockfile ? 'ci' : 'install',
            '--omit=dev',
            '--ignore-scripts',
            '--legacy-peer-deps',
            '--no-audit',
            '--no-fund',
            ...(lockfile ? [] : ['--no-package-lock']),
          ];
          await run(this.bins.npm, args, stage.dir, NPM_TIMEOUT_MS);
        }
        const id = stage.manifest.id;
        const target = path.join(this.home, id);
        const previous = path.join(this.home, '.previous', id);
        const lock = this.lock();
        const before = lock[id];
        if (existsSync(target)) {
          mkdirSync(path.dirname(previous), {recursive: true, mode: 0o700});
          rmSync(previous, {recursive: true, force: true});
          renameSync(target, previous);
        }
        renameSync(stage.dir, target);
        const {previous: _older, ...prior} = before ?? ({} as LockEntry);
        lock[id] = {
          id,
          version: stage.manifest.version,
          source: stage.source,
          hash: stage.hash,
          installedAt: Date.now(),
          reviewed: stage.reviewed,
          ...(before ? {previous: prior as Omit<LockEntry, 'previous'>} : {}),
        };
        this.ensureSdkLink();
        this.saveLock(lock);
        this.modules.reload();
        this.modules.logEvent({event: before ? 'update' : 'install', module: id, version: stage.manifest.version, source: describeSource(stage.source)});
        return {id, version: stage.manifest.version, updated: !!before};
      } finally {
        rmSync(stageRoot, {recursive: true, force: true});
      }
    });
  }

  /** Removes an installed module, its previous version, its settings and its saved secrets. */
  remove(id: string) {
    this.assertEnabled();
    return this.serial(() => {
      if (!ID.test(id)) throw new Error('No such module.');
      const target = path.join(this.home, id);
      const lock = this.lock();
      if (!existsSync(target) && !lock[id]) throw new Error('That module is not installed in the modules folder.');
      rmSync(target, {recursive: true, force: true});
      rmSync(path.join(this.home, '.previous', id), {recursive: true, force: true});
      delete lock[id];
      this.saveLock(lock);
      this.modules.forget(id);
      this.modules.reload();
      this.modules.logEvent({event: 'remove', module: id});
      return {id};
    });
  }

  /** Swaps the installed version with the one it replaced. */
  rollback(id: string) {
    this.assertEnabled();
    return this.serial(() => {
      const lock = this.lock();
      const entry = lock[id];
      const target = path.join(this.home, id);
      const previous = path.join(this.home, '.previous', id);
      if (!ID.test(id) || !entry?.previous || !existsSync(previous)) throw new Error('There is no earlier version to go back to.');
      const swap = path.join(this.home, '.previous', `${id}.${randomUUID()}`);
      renameSync(target, swap);
      renameSync(previous, target);
      renameSync(swap, previous);
      const {previous: older, ...current} = entry;
      lock[id] = {...older, previous: current};
      this.saveLock(lock);
      this.modules.reload();
      this.modules.logEvent({event: 'rollback', module: id, version: older.version});
      return {id, version: older.version};
    });
  }

  /** Install details for the module list: where it came from and whether it can go back a version. */
  info(id: string) {
    const entry = this.lock()[id];
    if (!entry) return undefined;
    return {
      source: describeSource(entry.source),
      reviewed: entry.reviewed,
      commit: 'commit' in entry.source ? entry.source.commit : undefined,
      installedAt: entry.installedAt,
      previous: entry.previous ? entry.previous.version : undefined,
    };
  }
}

function readJson(file: string) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Where a module comes from, ignoring the commit, so an update from the same place is not a change of source. */
function sourceKey(source: Source) {
  return source.kind === 'folder' ? `folder:${source.path}` : `${source.kind}:${source.url}#${source.path}`;
}

export function describeSource(source: Source) {
  if (source.kind === 'folder') return source.path;
  const where = source.path ? ` (${source.path})` : '';
  return `${source.url}${where} @ ${source.commit.slice(0, 10)}`;
}
