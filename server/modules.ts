import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writePrivate} from './account.js';
import {redact} from './redact.js';
import {DATA} from './security.js';
import {validTemplate, type LinkTemplate} from '../shared/pr-links.js';

// Modules add integrations without changing Muster: actions the owner runs from the Actions panel (with a
// preview and confirmation Muster enforces), described by a manifest, run in their own process.

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(DATA, 'modules');
mkdirSync(STATE, {recursive: true, mode: 0o700});
const SETTINGS_FILE = path.join(STATE, 'settings.json');
const SECRETS_FILE = path.join(STATE, 'secrets.json');
const ACTIVITY_FILE = path.join(STATE, 'activity.jsonl');
const INBOX_FILE = path.join(STATE, 'inbox.json');

/** Where installed modules live, one folder each. Modules are installed from a module repository, a git URL or a folder. */
export const MODULES_HOME = path.resolve(process.env.MUSTER_MODULES_DIR || path.join(os.homedir(), '.config/muster/modules'));
export const MODULE_DIRS = [MODULES_HOME];
const CHILD = path.join(ROOT, 'server/module-child.ts');
const PREVIEW_TTL_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 3 * 60 * 60_000;
const FEED_TIMEOUT_MS = 5 * 60_000;
const TOOL_TIMEOUT_MS = 2 * 60_000;
const MAX_TOOL_OUTPUT = 40_000;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,48}$/;
/** Tool names Pi or Muster already use; a module cannot take them. */
const RESERVED_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'browser', 'share_file']);
const MAX_INBOX = 500;
/** Connectors Muster can lend a module; each must be listed in the module's manifest. */
const CONNECTORS = ['composio'];

export type {Field, Preview, Progress} from '../packages/module-sdk/index.ts';
import type {Field, Preview, Progress} from '../packages/module-sdk/index.ts';

export type ActionInfo = {id: string; title: string; description?: string; confirm: 'always' | 'never'; policy?: string};
export type FeedInfo = {id: string; title: string; every: number};
export type ToolInfo = {name: string; description: string; parameters: Record<string, unknown>};
/** A Muster feature the module provides, such as reviewing and merging pull requests. */
export type Providers = {pullRequests?: {links: LinkTemplate[]; mergeAction: string}};
/** The policy a pull-request provider's merge action must carry: the owner reviewed this exact revision. */
export const REVIEWED_PR = 'reviewed-pr';

/** An Inbox entry: a feed item plus where it came from and whether the owner has dealt with it. */
export type InboxItem = {
  key: string;
  module: string;
  feed: string;
  source: string;
  id: string;
  title: string;
  text: string;
  author?: string;
  time: string;
  url?: string;
  place?: string;
  context?: string;
  group?: string;
  read: boolean;
  added: number;
  /** The thread started from it. */
  thread?: string;
};
type FeedStatus = {lastAt?: number; ok?: boolean; error?: string; running?: boolean; added?: number};
type InboxStore = {items: InboxItem[]; state: Record<string, unknown>; status: Record<string, FeedStatus>};

export type Manifest = {
  id: string;
  name: string;
  description?: string;
  version: string;
  apiVersion: 1;
  entry: string;
  network: string[];
  settings: Field[];
  actions: ActionInfo[];
  feeds: FeedInfo[];
  tools: ToolInfo[];
  connectors: string[];
  providers: Providers;
  dir: string;
};

export type ModuleRun = {
  id: string;
  module: string;
  action: string;
  title: string;
  input: Record<string, unknown>;
  preview: Preview;
  status: 'running' | 'succeeded' | 'failed';
  progress?: Progress;
  result?: Progress;
  error?: string;
  started: number;
  ended?: number;
};

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

function readJson(file: string, fallback: any) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function validField(field: any): field is Field {
  return (
    field &&
    typeof field.key === 'string' &&
    /^[A-Za-z0-9_:.-]{1,80}$/.test(field.key) &&
    typeof field.label === 'string' &&
    ['string', 'secret', 'text', 'number', 'select'].includes(field.type)
  );
}

/** Reads and checks a module manifest. Invalid manifests are skipped with a warning. */
export function loadManifest(dir: string): Manifest | undefined {
  const file = path.join(dir, 'muster-module.json');
  if (!existsSync(file)) return undefined;
  const raw = readJson(file, undefined);
  const problem =
    !raw || typeof raw !== 'object'
      ? 'not JSON'
      : !ID.test(raw.id)
        ? 'id must be lowercase letters, digits and dashes'
        : raw.apiVersion !== 1
          ? 'apiVersion must be 1'
          : typeof raw.entry !== 'string' || !existsSync(path.resolve(dir, raw.entry)) || !path.resolve(dir, raw.entry).startsWith(dir + path.sep)
            ? 'entry file missing'
            : !Array.isArray(raw.settings) || !raw.settings.every(validField)
              ? 'invalid settings'
              : !Array.isArray(raw.actions ?? []) || !(raw.actions ?? []).every((a: any) => ID.test(a?.id) && typeof a.title === 'string')
                ? 'invalid actions'
                : !Array.isArray(raw.feeds ?? []) || !(raw.feeds ?? []).every((f: any) => ID.test(f?.id) && typeof f.title === 'string')
                  ? 'invalid feeds'
                  : !Array.isArray(raw.connectors ?? []) || !(raw.connectors ?? []).every((c: unknown) => CONNECTORS.includes(c as string))
                    ? `unknown connector (known: ${CONNECTORS.join(', ')})`
                    : !Array.isArray(raw.tools ?? []) ||
                        !(raw.tools ?? []).every(
                          (t: any) =>
                            TOOL_NAME.test(t?.name) &&
                            !RESERVED_TOOLS.has(t.name) &&
                            typeof t.description === 'string' &&
                            t.parameters?.type === 'object',
                        )
                      ? 'invalid tools (lowercase snake_case names, a description, object parameters)'
                      : providerProblem(raw);
  if (problem) {
    console.warn(`Skipping module in ${dir}: ${problem}`);
    return undefined;
  }
  return {
    id: raw.id,
    name: String(raw.name || raw.id),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    version: String(raw.version || '0.0.0'),
    apiVersion: 1,
    entry: path.resolve(dir, raw.entry),
    network: Array.isArray(raw.network) ? raw.network.filter((h: unknown) => typeof h === 'string') : [],
    settings: raw.settings,
    feeds: (raw.feeds ?? []).map((f: any) => ({
      id: f.id,
      title: f.title,
      // Minutes between checks; at least one.
      every: Math.max(1, Number.isFinite(f.every) ? Number(f.every) : 5),
    })),
    connectors: raw.connectors ?? [],
    tools: (raw.tools ?? []).map((t: any) => ({name: t.name, description: t.description.slice(0, 2000), parameters: t.parameters})),
    providers: raw.providers?.pullRequests
      ? {pullRequests: {links: raw.providers.pullRequests.links.map((l: any) => ({host: l.host, path: l.path})), mergeAction: raw.providers.pullRequests.mergeAction}}
      : {},
    actions: (raw.actions ?? []).map((a: any) => ({
      id: a.id,
      title: a.title,
      description: typeof a.description === 'string' ? a.description : undefined,
      // Anything not explicitly marked otherwise needs the owner's confirmation.
      confirm: a.confirm === 'never' && !a.policy ? 'never' : 'always',
      policy: typeof a.policy === 'string' ? a.policy : undefined,
    })),
    dir,
  };
}

/** Why a manifest's providers are invalid, or '' if they are fine. A merge action must be gated by the owner's review. */
function providerProblem(raw: any) {
  if (raw.providers === undefined) return '';
  if (!raw.providers || typeof raw.providers !== 'object') return 'invalid providers';
  const known = ['pullRequests'];
  if (Object.keys(raw.providers).some(key => !known.includes(key))) return `unknown provider (known: ${known.join(', ')})`;
  const pr = raw.providers.pullRequests;
  if (pr === undefined) return '';
  if (!pr || !Array.isArray(pr.links) || !pr.links.length || !pr.links.every(validTemplate)) {
    return 'invalid pull request links (exact host, a path with one {number})';
  }
  const merge = (raw.actions ?? []).find((a: any) => a?.id === pr.mergeAction);
  if (!merge) return 'the pull request mergeAction is not one of the actions';
  if (merge.policy !== REVIEWED_PR) return `the pull request merge action must have policy "${REVIEWED_PR}"`;
  return '';
}

/** Hosts a module's code may contact: its manifest list plus the hosts of URLs in its own settings. */
export function allowedHosts(manifest: Manifest, values: Record<string, unknown>) {
  const hosts = new Set(manifest.network.map(host => host.toLowerCase()));
  for (const value of Object.values(values)) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/https?:\/\/[^\s,]+/g)) {
      try {
        hosts.add(new URL(match[0]).host.toLowerCase());
      } catch {
        // Not a URL.
      }
    }
  }
  return [...hosts];
}

const inputHash = (input: unknown) => createHash('sha256').update(JSON.stringify(input ?? {})).digest('hex');

export class Modules {
  manifests = new Map<string, Manifest>();
  runs = new Map<string, ModuleRun>();
  /** Host checks for actions that need more than confirmation, such as a current PR review. */
  actionPolicies = new Map<string, (input: Record<string, unknown>, call: {module: string; action: string}) => void>();
  private previews = new Map<string, {module: string; action: string; hash: string; at: number; preview: Preview}>();

  constructor(private dirs = MODULE_DIRS) {
    this.reload();
  }

  reload() {
    this.manifests.clear();
    for (const base of this.dirs) {
      let entries: string[] = [];
      try {
        entries = readdirSync(base);
      } catch {
        continue;
      }
      for (const name of entries) {
        const manifest = loadManifest(path.join(base, name));
        if (manifest && !this.manifests.has(manifest.id)) this.manifests.set(manifest.id, manifest);
      }
    }
  }

  private settings(): Record<string, {enabled?: boolean; values?: Record<string, unknown>}> {
    return readJson(SETTINGS_FILE, {});
  }

  private secrets(): Record<string, Record<string, string>> {
    return readJson(SECRETS_FILE, {});
  }

  get(id: string) {
    const manifest = this.manifests.get(id);
    if (!manifest) throw Object.assign(new Error('No such module.'), {status: 404});
    return manifest;
  }

  /** Values with defaults applied. Secret fields are never included. */
  values(manifest: Manifest) {
    const saved = this.settings()[manifest.id]?.values ?? {};
    const values: Record<string, unknown> = {};
    for (const field of manifest.settings) {
      if (field.type === 'secret') continue;
      values[field.key] = saved[field.key] ?? field.default ?? '';
    }
    return values;
  }

  enabled(id: string) {
    return this.settings()[id]?.enabled === true;
  }

  /** What the settings page and the Actions panel show. Secrets appear only as set or not set. */
  list() {
    const secrets = this.secrets();
    return [...this.manifests.values()].map(manifest => {
      const missing = manifest.settings.filter(field => field.required && !this.hasValue(manifest, field, secrets)).map(f => f.label);
      return {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        enabled: this.enabled(manifest.id),
        settings: manifest.settings,
        values: this.values(manifest),
        secretsSet: Object.fromEntries(
          manifest.settings.filter(f => f.type === 'secret').map(f => [f.key, !!secrets[manifest.id]?.[f.key]]),
        ),
        missing,
        actions: manifest.actions,
        feeds: manifest.feeds,
        tools: manifest.tools.map(tool => tool.name),
        providers: manifest.providers,
        connectors: manifest.connectors,
        network: allowedHosts(manifest, this.values(manifest)),
      };
    });
  }

  private hasValue(manifest: Manifest, field: Field, secrets = this.secrets()) {
    if (field.type === 'secret') return !!secrets[manifest.id]?.[field.key];
    const value = this.values(manifest)[field.key];
    return value !== '' && value !== undefined && value !== null;
  }

  /** Saves settings. Secrets are write-only: an empty value keeps the saved one, null removes it. */
  save(id: string, change: {enabled?: unknown; values?: unknown; secrets?: unknown}) {
    const manifest = this.get(id);
    const all = this.settings();
    const current = all[id] ?? {};
    const values: Record<string, unknown> = {...(current.values ?? {})};
    const incoming = change.values && typeof change.values === 'object' ? (change.values as Record<string, unknown>) : {};
    for (const field of manifest.settings) {
      if (field.type === 'secret' || !(field.key in incoming)) continue;
      const value = incoming[field.key];
      if (field.type === 'number') values[field.key] = value === '' || value === null ? '' : Number(value);
      else values[field.key] = String(value ?? '').slice(0, 4000);
    }
    all[id] = {enabled: typeof change.enabled === 'boolean' ? change.enabled : current.enabled === true, values};
    mkdirSync(STATE, {recursive: true, mode: 0o700});
    writePrivate(SETTINGS_FILE, JSON.stringify(all, null, 2));

    const incomingSecrets = change.secrets && typeof change.secrets === 'object' ? (change.secrets as Record<string, unknown>) : {};
    const secrets = this.secrets();
    const mine = {...(secrets[id] ?? {})};
    for (const field of manifest.settings) {
      if (field.type !== 'secret' || !(field.key in incomingSecrets)) continue;
      const value = incomingSecrets[field.key];
      if (value === null) delete mine[field.key];
      else if (typeof value === 'string' && value.trim()) mine[field.key] = value.trim().slice(0, 4000);
    }
    secrets[id] = mine;
    writePrivate(SECRETS_FILE, JSON.stringify(secrets, null, 2));
  }

  private ready(id: string, action: string) {
    const manifest = this.get(id);
    if (!this.enabled(id)) throw new Error(`${manifest.name} is turned off. Turn it on in Settings → Modules.`);
    const info = manifest.actions.find(a => a.id === action);
    if (!info) throw Object.assign(new Error('No such action.'), {status: 404});
    const missing = manifest.settings.filter(field => field.required && !this.hasValue(manifest, field));
    if (missing.length) throw new Error(`${manifest.name} needs settings first: ${missing.map(f => f.label).join(', ')}.`);
    return {manifest, info};
  }

  /** Runs one method of a module action in a fresh child process. Progress lines go to onProgress. */
  private call(
    manifest: Manifest,
    method: string,
    action: string,
    input: unknown,
    onProgress?: (p: Progress) => void,
    timeout = CALL_TIMEOUT_MS,
    extra: Record<string, unknown> = {},
  ) {
    const values = this.values(manifest);
    const request = {
      entry: manifest.entry,
      method,
      action,
      input,
      settings: values,
      secrets: this.secrets()[manifest.id] ?? {},
      network: allowedHosts(manifest, values),
      connectors: manifest.connectors,
      ...extra,
    };
    return new Promise<any>((resolve, reject) => {
      // A small environment: the module gets no Muster tokens, credentials or Pi settings.
      const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
        cwd: ROOT,
        env: {PATH: process.env.PATH ?? '', HOME: os.homedir(), NODE_ENV: 'production'},
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '';
      let stderr = '';
      let done = false;
      const finish = (error?: Error, value?: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGTERM');
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`${manifest.name} did not answer in time.`)), timeout);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.type === 'progress') onProgress?.(message.data ?? {});
          if (message.type === 'result') finish(undefined, message.data);
          if (message.type === 'error') finish(new Error(redact(String(message.message ?? 'Module failed')).slice(0, 1000)));
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.on('error', error => finish(error));
      child.on('close', code => finish(new Error(`${manifest.name} stopped (${code}). ${redact(stderr.trim().split('\n').at(-1) ?? '')}`)));
      child.stdin.end(JSON.stringify(request));
    });
  }

  /** Form fields for an action; a module can build them from live data, such as a repository's pipelines. */
  async fields(id: string, action: string): Promise<Field[]> {
    const {manifest} = this.ready(id, action);
    const fields = await this.call(manifest, 'fields', action, {});
    return Array.isArray(fields) ? fields.filter(validField) : [];
  }

  private checkPolicy(module: string, info: ActionInfo, input: Record<string, unknown>) {
    if (!info.policy) return;
    const policy = this.actionPolicies.get(info.policy);
    if (!policy) throw new Error('This action requires a host policy that is not available.');
    policy(input, {module, action: info.id});
  }

  /** The preview the owner must see before an action runs. Returns a single-use token for run(). */
  async preview(id: string, action: string, input: Record<string, unknown>) {
    const {manifest, info} = this.ready(id, action);
    this.checkPolicy(id, info, input);
    const raw = await this.call(manifest, 'preview', action, input);
    const preview: Preview = {
      summary: String(raw?.summary ?? '').slice(0, 500),
      details: Array.isArray(raw?.details) ? raw.details.map((d: unknown) => String(d).slice(0, 500)).slice(0, 20) : [],
      danger: raw?.danger === true,
      confirmLabel: typeof raw?.confirmLabel === 'string' ? raw.confirmLabel.slice(0, 60) : undefined,
      link: typeof raw?.link === 'string' && /^https:\/\//.test(raw.link) ? raw.link : undefined,
    };
    const token = randomUUID();
    for (const [key, old] of this.previews) if (Date.now() - old.at > PREVIEW_TTL_MS) this.previews.delete(key);
    this.previews.set(token, {module: id, action, hash: inputHash(input), at: Date.now(), preview});
    return {...preview, token};
  }

  /**
   * Starts an action. Actions that need confirmation run only with the token of a preview of exactly
   * these inputs, shown in the last ten minutes; each token works once.
   */
  run(id: string, action: string, input: Record<string, unknown>, token: unknown) {
    const {manifest, info} = this.ready(id, action);
    this.checkPolicy(id, info, input);
    const seen = typeof token === 'string' ? this.previews.get(token) : undefined;
    if (info.confirm === 'always') {
      if (!seen || seen.module !== id || seen.action !== action || seen.hash !== inputHash(input) || Date.now() - seen.at > PREVIEW_TTL_MS) {
        throw new Error('Preview the action again before running it.');
      }
    }
    if (seen) this.previews.delete(token as string);
    const run: ModuleRun = {
      id: randomUUID(),
      module: id,
      action,
      title: `${manifest.name}: ${info.title}`,
      input,
      preview: seen?.preview ?? {summary: info.title},
      status: 'running',
      started: Date.now(),
    };
    this.runs.set(run.id, run);
    this.log(run, 'started');
    this.call(manifest, 'run', action, input, progress => (run.progress = progress), RUN_TIMEOUT_MS)
      .then(result => {
        run.status = 'succeeded';
        run.result = result ?? {};
      })
      .catch(error => {
        run.status = 'failed';
        run.error = error.message;
      })
      .finally(() => {
        run.ended = Date.now();
        this.log(run, run.status);
      });
    for (const [key, old] of this.runs) if (this.runs.size > 50 && old.status !== 'running') this.runs.delete(key);
    return run;
  }

  private log(run: ModuleRun, event: string) {
    const entry = {at: Date.now(), event, run: run.id, module: run.module, action: run.action, input: run.input, preview: run.preview.summary, error: run.error, result: run.result};
    try {
      mkdirSync(STATE, {recursive: true, mode: 0o700});
      appendFileSync(ACTIVITY_FILE, redact(JSON.stringify(entry)) + '\n', {mode: 0o600});
    } catch {
      // The activity log is best effort.
    }
  }

  /** Adds an entry to the module activity log, such as an install. */
  logEvent(entry: Record<string, unknown>) {
    try {
      mkdirSync(STATE, {recursive: true, mode: 0o700});
      appendFileSync(ACTIVITY_FILE, redact(JSON.stringify({at: Date.now(), ...entry})) + '\n', {mode: 0o600});
    } catch {
      // Best effort.
    }
  }

  /** Deletes a module's settings and saved secrets, when it is removed. */
  forget(id: string) {
    const settings = this.settings();
    delete settings[id];
    writePrivate(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    const secrets = this.secrets();
    delete secrets[id];
    writePrivate(SECRETS_FILE, JSON.stringify(secrets, null, 2));
  }

  recentRuns() {
    return [...this.runs.values()].sort((a, b) => b.started - a.started).slice(0, 20);
  }

  // Providers: modules that supply a Muster feature, such as pull-request review and merge.

  /** Modules that provide pull requests, enabled or not; links only count for installed modules. */
  prProviders() {
    return [...this.manifests.values()]
      .filter(manifest => manifest.providers.pullRequests)
      .map(manifest => ({
        module: manifest.id,
        name: manifest.name,
        links: manifest.providers.pullRequests!.links,
        mergeAction: manifest.providers.pullRequests!.mergeAction,
        configured: this.enabled(manifest.id) && !manifest.settings.some(field => field.required && !this.hasValue(manifest, field)),
      }));
  }

  /** Calls a provider method, such as pullRequests.snapshot, in the module's own process. */
  async callProvider(id: string, provider: keyof Providers, method: string, input: Record<string, unknown>) {
    const manifest = this.get(id);
    if (!manifest.providers[provider]) throw new Error(`${manifest.name} does not provide ${provider}.`);
    if (!this.enabled(id)) throw new Error(`${manifest.name} is turned off. Turn it on in Settings → Modules.`);
    const missing = manifest.settings.filter(field => field.required && !this.hasValue(manifest, field));
    if (missing.length) throw new Error(`${manifest.name} needs settings first: ${missing.map(f => f.label).join(', ')}.`);
    return this.call(manifest, 'provider', method, input, undefined, TOOL_TIMEOUT_MS, {provider});
  }

  // Agent tools: enabled modules can give the agent read tools, such as searching Teams.

  /** Tools of enabled, configured modules, for the Pi extension that offers them to the agent. */
  agentTools() {
    const tools: (ToolInfo & {module: string; label: string})[] = [];
    const taken = new Set<string>();
    for (const manifest of this.manifests.values()) {
      if (!this.enabled(manifest.id)) continue;
      if (manifest.settings.some(field => field.required && !this.hasValue(manifest, field))) continue;
      for (const tool of manifest.tools) {
        if (taken.has(tool.name)) continue;
        taken.add(tool.name);
        tools.push({...tool, module: manifest.id, label: `${manifest.name}: ${tool.name}`});
      }
    }
    return tools;
  }

  /** Runs an agent tool in the module's own process and returns its text, trimmed for the model. */
  async callTool(name: string, input: Record<string, unknown>, thread?: string, maxOutput = MAX_TOOL_OUTPUT) {
    const tool = this.agentTools().find(entry => entry.name === name);
    if (!tool) throw new Error(`No enabled module offers the tool ${name}.`);
    const manifest = this.get(tool.module);
    const started = Date.now();
    let error: string | undefined;
    try {
      const result = await this.call(manifest, 'tool', name, input, undefined, TOOL_TIMEOUT_MS);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return text.length > maxOutput ? text.slice(0, maxOutput) + '\n[…output trimmed]' : text;
    } catch (failure: any) {
      error = failure.message;
      throw failure;
    } finally {
      // What was asked is logged, not what came back.
      const entry = {at: Date.now(), event: 'tool', module: manifest.id, tool: name, thread, input, ms: Date.now() - started, error};
      try {
        appendFileSync(ACTIVITY_FILE, redact(JSON.stringify(entry)) + '\n', {mode: 0o600});
      } catch {
        // Best effort.
      }
    }
  }

  // Inbox: feeds of enabled modules are checked on their own schedule; new items land unread.

  private inboxStore(): InboxStore {
    const store = readJson(INBOX_FILE, {});
    return {items: Array.isArray(store.items) ? store.items : [], state: store.state ?? {}, status: store.status ?? {}};
  }

  private saveInbox(store: InboxStore) {
    mkdirSync(STATE, {recursive: true, mode: 0o700});
    writePrivate(INBOX_FILE, JSON.stringify(store));
  }

  private polling = new Set<string>();
  /** Called after a check adds new items, such as the request grouping. */
  itemListeners = new Set<() => void>();

  /** Every Inbox item of the feeds that are on, newest first. */
  allItems() {
    const active = new Set(this.activeFeeds().map(entry => entry.key));
    return this.inboxStore().items.filter(item => active.has(`${item.module}:${item.feed}`));
  }

  /** Feeds of enabled modules that have their required settings. */
  private activeFeeds() {
    const feeds: {manifest: Manifest; feed: FeedInfo; key: string}[] = [];
    for (const manifest of this.manifests.values()) {
      if (!this.enabled(manifest.id)) continue;
      if (manifest.settings.some(field => field.required && !this.hasValue(manifest, field))) continue;
      for (const feed of manifest.feeds) feeds.push({manifest, feed, key: `${manifest.id}:${feed.id}`});
    }
    return feeds;
  }

  /** Checks one feed and merges what it returns into the Inbox. */
  async pollFeed(manifest: Manifest, feed: FeedInfo) {
    const key = `${manifest.id}:${feed.id}`;
    if (this.polling.has(key)) return;
    this.polling.add(key);
    const status = (fields: FeedStatus) => {
      const store = this.inboxStore();
      store.status[key] = {...store.status[key], ...fields};
      this.saveInbox(store);
    };
    status({running: true});
    try {
      const before = this.inboxStore().state[key] ?? null;
      const result = await this.call(manifest, 'feed', '', {}, undefined, FEED_TIMEOUT_MS, {feed: feed.id, state: before});
      const store = this.inboxStore();
      const known = new Map(store.items.map(item => [item.key, item]));
      let added = 0;
      for (const raw of Array.isArray(result?.items) ? result.items : []) {
        const item = cleanItem(raw);
        if (!item) continue;
        const itemKey = `${key}:${item.id}`;
        const old = known.get(itemKey);
        if (old) {
          // Edited in the source: keep the owner's read state and thread link.
          Object.assign(old, item, {read: old.read || item.read === true});
          continue;
        }
        const entry: InboxItem = {...item, key: itemKey, module: manifest.id, feed: feed.id, source: feed.title, read: item.read === true, added: Date.now()};
        store.items.push(entry);
        known.set(itemKey, entry);
        added++;
      }
      const readBefore = result?.readBefore && typeof result.readBefore === 'object' ? result.readBefore : {};
      for (const item of store.items) {
        const mark = item.module === manifest.id && item.feed === feed.id && item.group ? readBefore[item.group] : undefined;
        if (typeof mark === 'string' && Date.parse(item.time) <= Date.parse(mark)) item.read = true;
      }
      store.items.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      store.items = store.items.slice(0, MAX_INBOX);
      if (result && 'state' in result) store.state[key] = result.state ?? null;
      store.status[key] = {lastAt: Date.now(), ok: true, running: false, added};
      this.saveInbox(store);
      if (added) for (const listener of this.itemListeners) listener();
    } catch (error: any) {
      status({lastAt: Date.now(), ok: false, error: redact(String(error.message)).slice(0, 500), running: false});
    } finally {
      this.polling.delete(key);
    }
  }

  /** Checks every feed that is due, or all of them when forced. */
  pollDue(force = false) {
    const status = this.inboxStore().status;
    const jobs = this.activeFeeds()
      .filter(({key, feed}) => force || !status[key]?.lastAt || Date.now() - status[key].lastAt! >= feed.every * 60_000)
      .map(({manifest, feed}) => this.pollFeed(manifest, feed));
    return Promise.all(jobs);
  }

  private timer?: NodeJS.Timeout;
  /** Starts the background checks. */
  startInbox() {
    if (this.timer) return;
    // Runs left marked as running by a restart are not running any more.
    const store = this.inboxStore();
    for (const status of Object.values(store.status)) status.running = false;
    this.saveInbox(store);
    setTimeout(() => void this.pollDue(), 5_000).unref();
    this.timer = setInterval(() => void this.pollDue(), 60_000);
    this.timer.unref();
  }

  inbox() {
    const store = this.inboxStore();
    const active = new Set(this.activeFeeds().map(entry => entry.key));
    const feeds = this.activeFeeds().map(({manifest, feed, key}) => ({
      key,
      module: manifest.id,
      title: feed.title,
      every: feed.every,
      ...store.status[key],
      running: this.polling.has(key),
    }));
    const items = store.items.filter(item => active.has(`${item.module}:${item.feed}`));
    return {items, unread: items.filter(item => !item.read).length, feeds};
  }

  /** Marks items read or unread, and records the thread started from one. */
  markInbox(change: {keys?: unknown; all?: unknown; read?: unknown; thread?: unknown}) {
    const store = this.inboxStore();
    const keys = new Set(Array.isArray(change.keys) ? change.keys.filter((key): key is string => typeof key === 'string') : []);
    const read = change.read !== false;
    for (const item of store.items) {
      if (change.all !== true && !keys.has(item.key)) continue;
      item.read = read;
      if (typeof change.thread === 'string' && /^[0-9a-f-]{36}$/.test(change.thread)) item.thread = change.thread;
    }
    this.saveInbox(store);
  }
}

/** Checks a feed item's shape and trims its fields. Returns undefined for anything unusable. */
function cleanItem(raw: any) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || typeof raw.time !== 'string' || Number.isNaN(Date.parse(raw.time))) {
    return undefined;
  }
  const text = (value: unknown, max: number) => (typeof value === 'string' && value ? value.slice(0, max) : undefined);
  return {
    id: raw.id.slice(0, 300),
    title: text(raw.title, 200) ?? 'Untitled',
    text: text(raw.text, 8000) ?? '',
    author: text(raw.author, 120),
    time: new Date(raw.time).toISOString(),
    url: typeof raw.url === 'string' && /^https:\/\//.test(raw.url) ? raw.url.slice(0, 2000) : undefined,
    place: text(raw.place, 200),
    context: text(raw.context, 8000),
    group: text(raw.group, 300),
    read: raw.read === true,
  };
}

export const modules = new Modules();
