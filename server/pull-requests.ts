import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {writePrivate} from './account.js';
import {modules} from './modules.js';
import {DATA} from './security.js';
import {parsePrUrl} from '../modules/bitbucket-pull-requests/index.js';
import type {Thread} from './jobs.js';
import {sessionPrUrls} from '../shared/pr-links.js';

// PRs linked in a session, reviewed by the owner in Muster and merged after a confirmation. The owner's review
// is recorded against the exact source commit, target commit and diff they saw; any change needs another look.

const DIR = path.join(DATA, 'modules', 'pr-reviews');
const MODULE = 'bitbucket-pull-requests';
/** Large enough for real PRs; the module refuses diffs over its own limit. */
const MAX_SNAPSHOT = 8_000_000;

export type PrLink = {key: string; url: string; repository: string; number: string};
/** The owner's sign-off on one revision of a PR. */
export type Review = {url: string; source: string; destination: string; fingerprint: string; at: number; title?: string; target?: string};

/** PRs the assistant linked in this session, not links quoted by the user or imported as context. */
export function sessionPrs(thread: Pick<Thread, 'messages'>): PrLink[] {
  const found = new Map<string, PrLink>();
  for (const url of sessionPrUrls(thread.messages)) {
    const pr = parsePrUrl(url);
    const key = createHash('sha256').update(pr.url).digest('hex').slice(0, 20);
    found.set(key, {key, url: pr.url, repository: `${pr.workspace}/${pr.repo}`, number: pr.id});
  }
  return [...found.values()];
}

type Host = Pick<typeof modules, 'list' | 'callTool'>;

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

  list(thread: Thread) {
    const info = this.host.list().find(m => m.id === MODULE);
    return {configured: !!info?.enabled && !info.missing.length, prs: sessionPrs(thread).map(pr => ({...pr, review: this.get(pr.url)}))};
  }

  private link(thread: Thread, key: string) {
    const pr = sessionPrs(thread).find(p => p.key === key);
    if (!pr) throw Object.assign(new Error('No such PR in this session.'), {status: 404});
    return pr;
  }

  /** The PR as it is now: commits, checks, blockers and the full diff, for the owner to read. */
  async snapshot(thread: Thread, key: string) {
    const pr = this.link(thread, key);
    if (!this.list(thread).configured) throw new Error('Turn on Bitbucket pull requests and add its API token in Modules.');
    const data = JSON.parse(await this.host.callTool('bitbucket_pr_context', {url: pr.url}, thread.id, MAX_SNAPSHOT));
    return {...data, review: this.get(pr.url)};
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

  /** Used by both generic module routes and the session PR panel, so Actions cannot skip it. */
  requireReview(input: Record<string, unknown>) {
    const review = this.get(parsePrUrl(input.url).url);
    if (!review || review.source !== input.source || review.destination !== input.destination || review.fingerprint !== input.fingerprint) {
      throw new Error('Review the current diff first: open the PR in its session and mark it reviewed.');
    }
  }

  /** Merge input pinned to the owner's review. The module checks the live PR against it again. */
  input(thread: Thread, key: string) {
    const pr = this.link(thread, key);
    const review = this.get(pr.url);
    const input = {url: pr.url, source: review?.source, destination: review?.destination, fingerprint: review?.fingerprint};
    this.requireReview(input);
    return input;
  }
}

export const pullRequests = new PullRequests();
