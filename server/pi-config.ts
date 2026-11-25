import {execFile} from 'node:child_process';
import {chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writePrivate} from './account.js';
import {DATA} from './security.js';

// Managed threads run the owner's normal Pi: same extensions, skills, prompt templates, context
// files and default model. Two things differ: the BrowserOS neo MCP server is switched off so
// browser work goes through the app's takeover-aware tool, and the model can be chosen per run.

export const PI_BIN = process.env.PI_BIN || 'pi';
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type ModelInfo = {id: string; provider: string; model: string; thinking: boolean};

const caches = new Map<string, {at: number; models: ModelInfo[]}>();
const CACHE_MS = 10 * 60_000;

/** Forgets cached model lists so newly installed providers or credentials show up. */
export function clearModelCache() {
  caches.clear();
}

/** Models Pi can use with the configured credentials, from `pi --list-models`. */
export function listModels(): Promise<ModelInfo[]> {
  return modelList([]);
}

/** Models that exist without extensions; providers such as claude-bridge come from an extension. */
export function listCoreModels(): Promise<ModelInfo[]> {
  return modelList(['--no-extensions']);
}

async function modelList(flags: string[]): Promise<ModelInfo[]> {
  const key = flags.join(' ');
  const cache = caches.get(key);
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.models;
  const output = await new Promise<string>((resolve, reject) => {
    execFile(PI_BIN, [...flags, '--list-models'], {timeout: 60_000, maxBuffer: 4_000_000}, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  const models = output
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 5 && parts[0] && parts[1])
    .map(([provider, model, , , thinking]) => ({id: `${provider}/${model}`, provider, model, thinking: thinking === 'yes'}));
  if (models.length) caches.set(key, {at: Date.now(), models});
  return models;
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The owner's Pi defaults from settings.json. */
export function piDefaults() {
  const settings = readJson(path.join(AGENT_DIR, 'settings.json')) ?? {};
  const model = settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : '';
  return {model, thinking: typeof settings.defaultThinkingLevel === 'string' ? settings.defaultThinkingLevel : ''};
}

// Pi compacts automatically once context > window - compaction.reserveTokens (default 16384).
// Muster sets an earlier point per model with compaction.modelOverrides["provider/model"].reserveTokens.
const DEFAULT_RESERVE = 16384;

function plainObject(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

/**
 * Where Pi will auto-compact for this model in this folder. Pi merges the folder's .pi/settings.json over
 * the user settings, then looks for a model override, then the ordinary setting.
 */
export function compactionFor(model: string, cwd?: string) {
  const user = plainObject(readJson(path.join(AGENT_DIR, 'settings.json'))?.compaction) ?? {};
  const project = cwd ? plainObject(readJson(path.join(cwd, '.pi/settings.json'))?.compaction) ?? {} : {};
  const valid = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined);
  const projectModel = valid(plainObject(project.modelOverrides?.[model])?.reserveTokens);
  const userModel = valid(plainObject(user.modelOverrides?.[model])?.reserveTokens);
  const projectReserve = valid(project.reserveTokens);
  const userReserve = valid(user.reserveTokens);
  const reserveTokens = projectModel ?? userModel ?? projectReserve ?? userReserve ?? DEFAULT_RESERVE;
  const source =
    projectModel !== undefined || (userModel === undefined && projectReserve !== undefined)
      ? 'folder'
      : userModel !== undefined
        ? 'model'
        : userReserve !== undefined
          ? 'pi'
          : 'default';
  const enabled = (project.enabled ?? user.enabled) !== false;
  return {reserveTokens, source, enabled, defaultReserve: userReserve ?? DEFAULT_RESERVE};
}

/**
 * Sets the auto-compact point for one model in ~/.pi/agent/settings.json, or removes it (threshold null).
 * Only compaction.modelOverrides[model].reserveTokens changes; the rest of the file is kept as it is.
 */
export function setCompactionThreshold(model: string, contextWindow: number, threshold: number | null) {
  const file = path.join(AGENT_DIR, 'settings.json');
  let settings: Record<string, any> = {};
  if (existsSync(file)) {
    const parsed = plainObject(readJson(file));
    if (!parsed) throw new Error("Pi's settings.json could not be read, so it was left unchanged.");
    settings = parsed;
  }
  const compaction = (settings.compaction = plainObject(settings.compaction) ?? {});
  const overrides = (compaction.modelOverrides = plainObject(compaction.modelOverrides) ?? {});
  const entry = (overrides[model] = plainObject(overrides[model]) ?? {});
  if (threshold === null) delete entry.reserveTokens;
  else entry.reserveTokens = Math.max(0, Math.round(contextWindow - threshold));
  if (!Object.keys(entry).length) delete overrides[model];
  if (!Object.keys(overrides).length) delete compaction.modelOverrides;
  if (!Object.keys(compaction).length) delete settings.compaction;
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644;
  const temp = `${file}.muster-${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', {mode});
  chmodSync(temp, mode);
  renameSync(temp, file);
}

/** Validated model and thinking options for one run. Unknown values are dropped, not passed to Pi. */
export async function runOptions(requested: {model?: unknown; thinking?: unknown}) {
  const options: {model?: string; thinking?: string} = {};
  if (typeof requested.model === 'string' && requested.model) {
    const models = await listModels().catch(() => []);
    if (models.some(model => model.id === requested.model)) options.model = requested.model;
  }
  if (typeof requested.thinking === 'string' && THINKING_LEVELS.includes(requested.thinking)) {
    options.thinking = requested.thinking;
  }
  return options;
}

const MCP_SOURCES = [
  path.join(os.homedir(), '.config/mcp/mcp.json'),
  path.join(os.homedir(), '.agents/mcp.json'),
  path.join(os.homedir(), '.agents/mcp/mcp.json'),
  path.join(AGENT_DIR, 'mcp.json'),
];

/**
 * Writes the MCP config passed with --mcp-config. That flag replaces the Pi global layer
 * (~/.pi/agent/mcp.json), so the file starts from that layer and adds `disabled: true` for every
 * BrowserOS server. The adapter merges per field, so the rest of each server's settings still apply.
 */
export function mcpOverrideFile() {
  const piLayer = readJson(path.join(AGENT_DIR, 'mcp.json')) ?? {};
  const config = {...piLayer, mcpServers: {...(piLayer.mcpServers ?? {})}};
  for (const source of MCP_SOURCES) {
    if (!existsSync(source)) continue;
    for (const name of Object.keys(readJson(source)?.mcpServers ?? {})) {
      if (/browseros/i.test(name)) config.mcpServers[name] = {...(config.mcpServers[name] ?? {}), disabled: true};
    }
  }
  const file = path.join(DATA, 'pi-mcp.json');
  writePrivate(file, JSON.stringify(config, null, 2));
  return file;
}
