import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {writePrivate} from './account.js';
import {modules, REVIEWED_PR} from './modules.js';
import {DATA} from './security.js';
import type {Thread} from './jobs.js';
import {prFingerprint, type PullRequestSnapshot} from '../packages/module-sdk/index.ts';
import {matchPrLink, sessionPrLinks} from '../shared/pr-links.js';

// PRs linked in a session, reviewed by the owner in Muster and merged after a confirmation. A pull-request provider
// module (such as Bitbucket pull requests) reads and merges them; Muster owns the review: the owner's sign-off is
// recorded against the exact source commit, target commit and diff they saw, and any change needs another look.

const DIR = path.join(DATA, 'modules', 'pr-reviews');
/** Large enough for real PRs; providers refuse diffs over their own limit. */
const MAX_DIFF = 5_000_000;

export type PrLink = {key: string; url: string; module: string; repository: string; number: string};
/** The owner's sign-off on one revision of a PR. */
export type Review = {url: string; source: string; destination: string; fingerprint: string; at: number; title?: string; target?: string};

type Host = Pick<typeof modules, 'prProviders' | 'callProvider'>;

const HASH = /^[a-f0-9]{40,64}$/;

/** Checks a provider's snapshot and replaces its fingerprint with Muster's own. */
export function checkSnapshot(raw: any, url: string): PullRequestSnapshot {
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
  if (!raw || typeof raw !== 'object') throw new Error('The pull request module returned nothing.');
  if (raw.url !== url) throw new Error('The pull request module returned a different PR.');
  if (!HASH.test(String(raw.source)) || !HASH.test(String(raw.destination))) throw new Error('The pull request module returned no commit hashes.');
  if (typeof raw.diff !== 'string' || raw.diff.length > MAX_DIFF) throw new Error('The pull request module returned no usable diff.');
  return {
    url,
    title: text(raw.title, 500),
    description: text(raw.description, 12_000),
    state: text(raw.state, 40) || 'UNKNOWN',
    source: raw.source,
    destination: raw.destination,
    sourceBranch: text(raw.sourceBranch, 300),
    target: text(raw.target, 300),
    approvals: Number.isSafeInteger(raw.approvals) ? raw.approvals : 0,
    statuses: (Array.isArray(raw.statuses) ? raw.statuses : []).slice(0, 50).map((s: any) => ({name: text(s?.name, 200), state: text(s?.state, 40)})),
    blockers: (Array.isArray(raw.blockers) ? raw.blockers : []).slice(0, 30).map((b: unknown) => text(b, 500)),
    diff: raw.diff,
    fingerprint: prFingerprint(url, raw.source, raw.destination, raw.diff),
  };
}

export class PullRequests {
  constructor(private storeDir = DIR, private host: Host = modules) {}

  private file(url: string) {
    return path.join(this.storeDir, createHash('sha256').update(url).digest('hex') + '.json');
  }

  get(url: string): Review | undefined {
    try {
      const review = JSON.parse(readFileSync(this.file(url), 'utf8'));
      // Records from the earlier model review are not the owner's sign-off.
      return typeof review.at === 'number' && review.source && review.fingerprint ? review : undefined;
    } catch {
      return undefined;
    }
  }

  /** PRs the assistant linked in this session that an installed provider module handles. */
  links(thread: Pick<Thread, 'messages'>): PrLink[] {
    return sessionPrLinks(thread.messages, this.host.prProviders()).map(link => ({
      ...link,
      key: createHash('sha256').update(link.url).digest('hex').slice(0, 20),
    }));
  }

  list(thread: Thread) {
    const providers = this.host.prProviders();
    const byModule = new Map(providers.map(provider => [provider.module, provider]));
    return {
      providers: providers.map(({module, name, configured}) => ({module, name, configured})),
      prs: this.links(thread).map(pr => {
        const provider = byModule.get(pr.module)!;
        return {...pr, moduleName: provider.name, configured: provider.configured, review: this.get(pr.url)};
      }),
    };
  }

  private link(thread: Thread, key: string) {
    const pr = this.links(thread).find(p => p.key === key);
    if (!pr) throw Object.assign(new Error('No such PR in this session.'), {status: 404});
    return pr;
  }

  private provider(module: string) {
    const provider = this.host.prProviders().find(p => p.module === module);
    if (!provider) throw new Error('The module for this PR is no longer installed.');
    return provider;
  }

  /** The PR as it is now: commits, checks, blockers and the full diff, for the owner to read. */
  async snapshot(thread: Thread, key: string) {
    const pr = this.link(thread, key);
    const data = checkSnapshot(await this.host.callProvider(pr.module, 'pullRequests', 'snapshot', {url: pr.url}), pr.url);
    return {...data, module: pr.module, review: this.get(pr.url)};
  }

  /**
   * Records that the owner reviewed the diff they were shown. The PR is fetched again first, so a push after
   * the diff was opened cannot slip in under the sign-off.
   */
  async markReviewed(thread: Thread, key: string, seen: {source?: unknown; destination?: unknown; fingerprint?: unknown}) {
    const pr = this.link(thread, key);
    const now = await this.snapshot(thread, key);
    if (now.source !== seen.source || now.destination !== seen.destination || now.fingerprint !== seen.fingerprint) {
      throw new Error('The PR changed since you opened the diff. Open it again and review the new version.');
    }
    const review: Review = {url: pr.url, source: now.source, destination: now.destination, fingerprint: now.fingerprint, at: Date.now(), title: now.title, target: now.target};
    mkdirSync(this.storeDir, {recursive: true, mode: 0o700});
    writePrivate(this.file(pr.url), JSON.stringify(review));
    return review;
  }

  /**
   * The reviewed-pr policy, checked before any merge action's preview and run, including from the generic Actions
   * routes. The PR must belong to the module asking, and the owner must have reviewed this exact revision.
   */
  requireReview(input: Record<string, unknown>, call: {module: string}) {
    const link = typeof input.url === 'string' ? matchPrLink(input.url, this.host.prProviders()) : undefined;
    if (!link || link.url !== input.url || link.module !== call.module) throw new Error('This PR is not handled by this module.');
    const review = this.get(link.url);
    if (!review || review.source !== input.source || review.destination !== input.destination || review.fingerprint !== input.fingerprint) {
      throw new Error('Review the current diff first: open the PR in its session and mark it reviewed.');
    }
  }

  /** The provider's merge action and its input, pinned to the owner's review. The module checks the live PR again. */
  merge(thread: Thread, key: string) {
    const pr = this.link(thread, key);
    const review = this.get(pr.url);
    const input = {url: pr.url, source: review?.source, destination: review?.destination, fingerprint: review?.fingerprint};
    this.requireReview(input, {module: pr.module});
    return {module: pr.module, action: this.provider(pr.module).mergeAction, input};
  }
}

export const pullRequests = new PullRequests();
export {REVIEWED_PR};
