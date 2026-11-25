// A fake module context for tests: no network unless you provide fetch, no Composio unless you provide it.
import type {ModuleContext} from './index.ts';

export type TestContextOptions = {
  settings?: Record<string, any>;
  secrets?: Record<string, string>;
  /** Answers the module's requests. Receives the URL and init the module passed. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  /** Answers ctx.composio calls; leave it out for modules without the composio connector. */
  composio?: (url: string, options: {toolkit: string; method?: string; body?: unknown}) => Promise<any> | any;
  /** Hosts the module may contact; requests to others fail, as in Muster. Leave it out to allow any. */
  network?: string[];
};

export type TestContext = ModuleContext & {
  /** Every request the module made, in order. */
  requests: {url: string; method: string; body?: string}[];
  logs: unknown[][];
};

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const requests: TestContext['requests'] = [];
  const logs: unknown[][] = [];
  const allowed = options.network && new Set(options.network.map(host => host.toLowerCase()));
  const ctx: TestContext = {
    settings: options.settings ?? {},
    secret: key => options.secrets?.[key],
    async fetch(url, init) {
      const host = new URL(url).host.toLowerCase();
      if (allowed && !allowed.has(host)) throw new Error(`This module may not contact ${host}. Add it to the manifest's network list.`);
      requests.push({url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined});
      if (!options.fetch) throw new Error(`No fetch handler in the test context for ${url}.`);
      return options.fetch(url, init);
    },
    log: (...args) => logs.push(args),
    requests,
    logs,
  };
  if (options.composio) {
    const answer = options.composio;
    ctx.composio = async (url, call) => {
      const host = new URL(url).host.toLowerCase();
      if (allowed && !allowed.has(host)) throw new Error(`This module may not contact ${host}. Add it to the manifest's network list.`);
      requests.push({url, method: call.method ?? 'GET', body: call.body === undefined ? undefined : JSON.stringify(call.body)});
      return answer(url, call);
    };
  }
  return ctx;
}
