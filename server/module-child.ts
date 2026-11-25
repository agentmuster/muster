// Runs one call of a Muster module in its own process. Reads one JSON request from stdin and writes
// JSON lines to stdout: progress updates, then a result or an error.
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import type {ModuleContext, MusterModule} from './module-api.js';

const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

try {
  const request = JSON.parse(raw);
  const allowed = new Set<string>(request.network ?? []);
  const secrets: Record<string, string> = request.secrets ?? {};

  const ctx: ModuleContext = {
    settings: request.settings ?? {},
    secret: (key: string) => secrets[key],
    /** fetch limited to the hosts the manifest and the module's settings name; https except on loopback. */
    async fetch(url: string, init?: RequestInit) {
      let target = new URL(url);
      // Redirects are followed only to hosts the module may contact anyway.
      for (let hop = 0; hop < 4; hop++) {
        const host = target.host.toLowerCase();
        if (!allowed.has(host)) throw new Error(`This module may not contact ${host}. Add it to the manifest's network list.`);
        if (target.protocol !== 'https:' && !(target.protocol === 'http:' && LOOPBACK.has(target.hostname))) {
          throw new Error('Modules may only use https.');
        }
        const response = await fetch(target, {...init, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(30_000)});
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) return response;
        target = new URL(location, target);
      }
      throw new Error('Too many redirects.');
    },
    log: (...args: unknown[]) => console.error(...args),
  };
  if ((request.connectors ?? []).includes('composio')) {
    ctx.composio = (url, options) => composio(url, options, allowed);
  }

  const loaded = await import(pathToFileURL(request.entry).href);
  const module: MusterModule = loaded.default ?? loaded;
  let result: unknown;
  if (request.method === 'feed') {
    const feed = module.feeds?.[request.feed];
    if (!feed) throw new Error(`The module has no feed "${request.feed}".`);
    write({type: 'result', data: await feed.list(ctx, request.state ?? null)});
    process.exit(0);
  }
  if (request.method === 'tool') {
    const tool = module.tools?.[request.action];
    if (typeof tool !== 'function') throw new Error(`The module has no tool "${request.action}".`);
    write({type: 'result', data: await tool(ctx, request.input ?? {})});
    process.exit(0);
  }
  const action = module.actions?.[request.action];
  if (!action) throw new Error(`The module has no action "${request.action}".`);

  if (request.method === 'fields') result = action.fields ? await action.fields(ctx) : [];
  else if (request.method === 'preview') result = await action.preview(ctx, request.input ?? {});
  else if (request.method === 'run') result = await action.run(ctx, request.input ?? {}, progress => write({type: 'progress', data: progress}));
  else throw new Error('Unknown method');
  write({type: 'result', data: result ?? null});
  process.exit(0);
} catch (error: any) {
  write({type: 'error', message: error?.message ?? String(error)});
  process.exit(1);
}

/** Runs `composio proxy` and returns the API's JSON answer. */
async function composio(url: string, options: {toolkit: string; method?: string; body?: unknown}, allowed: Set<string>) {
  const host = new URL(url).host.toLowerCase();
  if (!allowed.has(host)) throw new Error(`This module may not contact ${host}. Add it to the manifest's network list.`);
  if (!/^[a-z0-9_-]{1,60}$/.test(options.toolkit)) throw new Error('Invalid Composio toolkit name.');
  const method = (options.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Invalid method.');
  const args = ['proxy', url, '--toolkit', options.toolkit, '--method', method];
  if (options.body !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(options.body));
  return new Promise<any>((resolve, reject) => {
    const child = spawn('composio', args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    child.on('error', error =>
      reject(new Error(error.message.includes('ENOENT') ? 'The Composio CLI is not installed on this desktop.' : error.message)),
    );
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(out);
        if (data?.successful === false) {
          const hint = /NoActiveConnection/.test(String(data.slug)) ? ` Run: composio link ${options.toolkit}` : '';
          return reject(new Error(String(data.error ?? 'Composio call failed') + hint));
        }
        if (data?.error?.code === 'InvalidAuthenticationToken') {
          return reject(new Error(`The ${options.toolkit} connection has expired. Run: composio link ${options.toolkit}`));
        }
        resolve(data);
      } catch {
        const reason = (err || out).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').find(line => line.trim()) ?? '';
        reject(new Error('Composio call failed' + (reason ? ': ' + reason.slice(0, 300) : '')));
      }
    });
  });
}
