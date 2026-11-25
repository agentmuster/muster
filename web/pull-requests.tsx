import {lazy, Suspense, useEffect, useState} from 'react';
import './pull-requests.css';

// The Pull requests tab of a session's Files panel: the owner reads a PR's diff, marks it reviewed, then merges
// it after Muster checks that nothing changed and the owner confirms.

const DiffView = lazy(() => import('./diff-view'));

type Api = (url: string, body?: unknown) => Promise<any>;
type Review = {source: string; destination: string; fingerprint: string; at: number};
type Pr = {key: string; url: string; module: string; moduleName: string; configured: boolean; repository: string; number: string; review?: Review};
type Data = {providers: {module: string; name: string; configured: boolean}[]; prs: Pr[]};
type Snapshot = {
  title: string;
  description: string;
  state: string;
  source: string;
  destination: string;
  sourceBranch: string;
  target: string;
  approvals: number;
  statuses: {name: string; state: string}[];
  blockers: string[];
  diff: string;
  fingerprint: string;
  review?: Review;
};
type Preview = {token: string; summary: string; details?: string[]; confirmLabel: string};
type Run = {id: string; status: string; progress?: {text?: string}; result?: {text?: string}; error?: string};

const short = (hash?: string) => (hash ?? '').slice(0, 8);
const when = (at: number) => new Date(at).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

type FilePatch = {name: string; note: string; patch: string; added: number; removed: number};

/** Splits a unified diff into one patch per file, with its name and line counts. */
export function splitDiff(diff: string): FilePatch[] {
  const parts = diff.split(/^(?=diff --git )/m).filter(part => part.startsWith('diff --git '));
  return parts.map(patch => {
    const lines = patch.split('\n');
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0]);
    const renamedFrom = lines.find(line => line.startsWith('rename from '))?.slice(12);
    const renamedTo = lines.find(line => line.startsWith('rename to '))?.slice(10);
    const plus = lines.find(line => line.startsWith('+++ '))?.slice(4);
    const minus = lines.find(line => line.startsWith('--- '))?.slice(4);
    const strip = (path?: string) => (path && path !== '/dev/null' ? path.replace(/^[ab]\//, '') : undefined);
    const name = renamedTo ?? strip(plus) ?? strip(minus) ?? header?.[2] ?? 'file';
    const note = renamedFrom
      ? `renamed from ${renamedFrom}`
      : lines.some(line => line.startsWith('new file mode'))
        ? 'new'
        : lines.some(line => line.startsWith('deleted file mode'))
          ? 'deleted'
          : lines.some(line => line.startsWith('Binary files'))
            ? 'binary'
            : '';
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return {name, note, patch, added, removed};
  });
}

/** One row per file, collapsed until tapped; a file's diff renders only while it is open. */
function FileAccordion({diff}: {diff: string}) {
  const files = splitDiff(diff);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (index: number) =>
    setOpen(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  if (!files.length) return <p className="file-note">This PR has no text changes to show.</p>;
  const allOpen = open.size === files.length;
  return (
    <div className="pr-files">
      <button className="quiet pr-expand-all" onClick={() => setOpen(allOpen ? new Set() : new Set(files.map((_, i) => i)))}>
        {allOpen ? 'Collapse all' : 'Expand all'}
      </button>
      {files.map((file, index) => {
        const expanded = open.has(index);
        const slash = file.name.lastIndexOf('/');
        return (
          <section key={index} className={'pr-file' + (expanded ? ' open' : '')}>
            <button className="pr-file-head" aria-expanded={expanded} onClick={() => toggle(index)}>
              <span className="pr-file-chevron" aria-hidden="true">
                ›
              </span>
              <span className="pr-file-name">
                <strong>{file.name.slice(slash + 1)}</strong>
                {slash > 0 && <small>{file.name.slice(0, slash)}</small>}
              </span>
              {file.note && <em className="pr-file-note">{file.note}</em>}
              <span className="pr-file-count">
                <b className="plus">+{file.added}</b> <b className="minus">−{file.removed}</b>
              </span>
            </button>
            {expanded && (
              <Suspense fallback={<p className="file-note">Loading…</p>}>
                <DiffView patch={file.patch} />
              </Suspense>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Files and line counts of a unified diff. */
function diffStats(diff: string) {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return {files, added, removed};
}

function PrCard(props: {pr: Pr; root: string; api: Api; configured: boolean; refresh: () => void}) {
  const {pr, api} = props;
  const route = `${props.root}/${pr.key}`;
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [run, setRun] = useState<Run | null>(null);

  // Follow a merge until the service answers.
  useEffect(() => {
    if (run?.status !== 'running') return;
    let live = true;
    const timer = window.setInterval(() => {
      void api('/modules/runs/' + run.id)
        .then(next => live && setRun(next))
        .catch(e => live && setError(e.message));
    }, 1500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [run?.id, run?.status]);

  const step = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await work();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const load = () =>
    step('Loading the diff…', async () => {
      setPreview(null);
      setSnap(await api(route + '/diff'));
      setOpen(true);
    });
  const markReviewed = () =>
    step('Saving…', async () => {
      await api(route + '/reviewed', {source: snap!.source, destination: snap!.destination, fingerprint: snap!.fingerprint});
      props.refresh();
      setSnap(await api(route + '/diff'));
    });
  const checkMerge = () => step('Checking…', async () => setPreview(await api(route + '/preview', {})));
  const merge = () =>
    step('Merging…', async () => {
      setRun(await api(route + '/merge', {token: preview!.token}));
      setPreview(null);
    });

  const review = snap?.review ?? pr.review;
  // The sign-off counts only for the revision on screen; a push after it needs another review.
  const current = !!review && (!snap || (review.source === snap.source && review.destination === snap.destination && review.fingerprint === snap.fingerprint));
  const stats = snap ? diffStats(snap.diff) : null;
  const merged = run?.status === 'succeeded' || snap?.state === 'MERGED';

  return (
    <article className="pr-card">
      <a className="pr-title" href={pr.url} target="_blank" rel="noopener">
        {pr.repository} #{pr.number} ↗
      </a>
      {snap && (
        <>
          <strong className="pr-name">{snap.title}</strong>
          <small className="muted">
            {snap.sourceBranch} → {snap.target} · {stats!.files} {stats!.files === 1 ? 'file' : 'files'}{' '}
            <b className="plus">+{stats!.added}</b> <b className="minus">−{stats!.removed}</b> · {snap.approvals} approvals
            {snap.state !== 'OPEN' ? ` · ${snap.state.toLowerCase()}` : ''}
          </small>
          {!!snap.statuses.length && (
            <div className="pr-statuses">
              {snap.statuses.map((status, i) => (
                <span key={i} className={'pr-status ' + status.state.toLowerCase()}>
                  {status.name}: {status.state.toLowerCase()}
                </span>
              ))}
            </div>
          )}
          {!!snap.blockers.length && (
            <div className="pr-blockers">
              <strong>Can't merge yet</strong>
              <ul>
                {snap.blockers.map((blocker, i) => (
                  <li key={i}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
          {snap.description && open && (
            <details className="pr-description">
              <summary>Description</summary>
              <p>{snap.description}</p>
            </details>
          )}
        </>
      )}
      {review && (
        <p className={'pr-reviewed' + (current ? '' : ' stale')}>
          {current
            ? `✓ You reviewed this on ${when(review.at)}, at ${short(review.source)}.`
            : `You reviewed an earlier version (${short(review.source)}). It has changed since; review the new diff.`}
        </p>
      )}
      {open && snap && (
        <div className="pr-diff">
          <FileAccordion diff={snap.diff} />
        </div>
      )}
      {run && (
        <p className={run.status === 'failed' ? 'pr-error' : 'pr-done'} role="status">
          {run.error || run.result?.text || run.progress?.text || 'Starting the merge…'}
        </p>
      )}
      {preview ? (
        <div className="pr-confirm" role="group" aria-label="Confirm merge">
          <strong>{preview.summary}</strong>
          <ul>
            {preview.details?.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <div className="pr-buttons">
            <button onClick={() => setPreview(null)} disabled={!!busy}>
              Cancel
            </button>
            <button className="primary" onClick={() => void merge()} disabled={!!busy}>
              {busy === 'Merging…' ? busy : preview.confirmLabel || 'Merge this PR'}
            </button>
          </div>
        </div>
      ) : (
        !merged && (
          <div className="pr-buttons">
            {open ? (
              <button onClick={() => setOpen(false)} disabled={!!busy}>
                Hide diff
              </button>
            ) : (
              <button onClick={() => void load()} disabled={!props.configured || !!busy}>
                {busy === 'Loading the diff…' ? busy : snap ? 'View diff' : 'Review diff'}
              </button>
            )}
            {open && snap && !current && (
              <button className="primary" onClick={() => void markReviewed()} disabled={!!busy || snap.state !== 'OPEN'}>
                {busy === 'Saving…' ? busy : "I've reviewed this diff"}
              </button>
            )}
            {current && (
              <button className="primary" onClick={() => void checkMerge()} disabled={!props.configured || !!busy || (!!snap && snap.blockers.length > 0)}>
                {busy === 'Checking…' ? busy : 'Merge…'}
              </button>
            )}
          </div>
        )
      )}
      {error && (
        <p className="pr-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export default function PullRequestsPanel(props: {threadId: string; api: Api; openSettings: (module?: string) => void}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const root = `/threads/${props.threadId}/pull-requests`;
  const refresh = () =>
    props
      .api(root)
      .then(setData)
      .catch(e => setError(e.message === 'Not found' ? 'PR tools will appear after the next idle restart.' : e.message));
  useEffect(() => {
    void refresh();
  }, [root]);
  if (!data) return <p className="file-note">{error || 'Loading pull requests…'}</p>;
  return (
    <div className="pr-panel">
      <p className="muted">
        PRs the agent linked in this session. Read the diff, mark it reviewed, then merge. Muster checks again that nothing changed before
        it merges.
      </p>
      {!data.providers.length && (
        <div className="pr-setup">
          <p>Reviewing and merging needs a pull-request module for your code host, such as Bitbucket pull requests. Install one from Modules.</p>
          <button className="primary" onClick={() => props.openSettings()}>
            Open modules
          </button>
        </div>
      )}
      {/* One note per module that is installed but not ready, such as a missing token. */}
      {[...new Map(data.prs.filter(pr => !pr.configured).map(pr => [pr.module, pr])).values()].map(pr => (
        <div key={pr.module} className="pr-setup">
          <p>Turn on {pr.moduleName} and finish its settings to review these PRs.</p>
          <button className="primary" onClick={() => props.openSettings(pr.module)}>
            Open {pr.moduleName}
          </button>
        </div>
      ))}
      {data.prs.map(pr => (
        <PrCard key={pr.key} pr={pr} root={root} api={props.api} configured={pr.configured} refresh={() => void refresh()} />
      ))}
      {error && <p className="pr-error">{error}</p>}
      {!data.prs.length && <p className="file-note">PR links the agent posts in this session will appear here.</p>}
    </div>
  );
}
