// The API a Muster module is written against (apiVersion 1).
import type {Field, Preview, Progress} from './modules.js';

export type {Field, Preview, Progress};

export type ModuleContext = {
  /** The module's settings from Settings → Modules, with defaults applied. Secrets are not included. */
  settings: Record<string, any>;
  /** A secret setting, such as an API token. Never log it or return it. */
  secret(key: string): string | undefined;
  /** fetch, limited to the hosts in the manifest's network list and in URLs in the module's settings. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Writes to Muster's log, not to the owner. */
  log(...args: unknown[]): void;
  /**
   * Calls an app's API through the Composio CLI signed in on this desktop, for modules whose manifest lists
   * "composio" in connectors. The URL's host must still be in the manifest's network list.
   */
  composio?(url: string, options: {toolkit: string; method?: string; body?: unknown}): Promise<any>;
};

/** One item in the Inbox, such as a Teams message. */
export type FeedItem = {
  id: string;
  title: string;
  text: string;
  author?: string;
  /** ISO time the item happened. */
  time: string;
  url?: string;
  /** Where it happened, such as "Acme › General". */
  place?: string;
  /** Earlier text it replies to, passed along when a session starts from it. */
  context?: string;
  /** The conversation it belongs to, such as a chat id; readBefore marks a whole conversation read. */
  group?: string;
  /** Already read in the source app. */
  read?: boolean;
};

export type FeedResult = {
  items: FeedItem[];
  /** Returned to the next call as state; keep cursors here. */
  state?: any;
  /** Per group, the time up to which the owner has read it in the source app. Older items are marked read. */
  readBefore?: Record<string, string>;
};

export type Feed = {
  /** New items since the last check. state is whatever the previous call returned (null the first time). */
  list(ctx: ModuleContext, state: any): Promise<FeedResult>;
};

export type Action = {
  /** Form fields for the action. Optional; a module can read them from live data. */
  fields?(ctx: ModuleContext): Promise<Field[]> | Field[];
  /** What will happen, shown before the owner confirms. Must not change anything. */
  preview(ctx: ModuleContext, input: Record<string, any>): Promise<Preview> | Preview;
  /** Does the work. Calls progress as it goes; the returned value is the final status. */
  run(ctx: ModuleContext, input: Record<string, any>, progress: (update: Progress) => void): Promise<Progress | void>;
};

/**
 * A tool the agent can call while working in a session. Its name, description and parameters are in the
 * manifest's tools list; the code returns plain text for the model. Tools should only read.
 */
export type Tool = (ctx: ModuleContext, input: Record<string, any>) => Promise<string> | string;

export type MusterModule = {actions?: Record<string, Action>; feeds?: Record<string, Feed>; tools?: Record<string, Tool>};

/** Identity helper for type checking: export default defineModule({actions: {...}}). */
export const defineModule = (module: MusterModule) => module;
