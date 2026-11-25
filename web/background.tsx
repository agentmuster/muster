import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

// Subagents and workflows the agent started in the background: a count in the thread header and above the
// message box, and a panel listing each one, with its task, progress and the end of its output.

export type BackgroundItem = {
  kind: 'subagent' | 'workflow';
  id: string;
  title: string;
  task?: string;
  state: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';
  active: boolean;
  started?: number;
  ended?: number;
  tokens?: number;
  cost?: number;
  progress?: string;
  phase?: string;
  labels?: string[];
};
export type ThreadBackground = {active: number; items: BackgroundItem[]; at: number};
type Api = (url: string, body?: unknown) => Promise<any>;
type Detail = BackgroundItem & {output: string; steps?: {agent: string; status: string}[]};

const STATE: Record<BackgroundItem['state'], string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Needs attention',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};
const KIND = {subagent: 'Subagent', workflow: 'Workflow'};

function duration(item: BackgroundItem) {
  if (!item.started) return '';
  const seconds = Math.max(0, Math.round(((item.ended ?? Date.now()) - item.started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
const tokens = (n?: number) => (n === undefined ? '' : n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M tokens' : n >= 1000 ? Math.round(n / 1000) + 'k tokens' : n + ' tokens');
const money = (n?: number) => (n ? '$' + (n < 0.1 ? n.toFixed(3) : n.toFixed(2)) : '');

/** "2 subagents running", or what ran most recently. */
export function backgroundLabel(background?: ThreadBackground) {
  const active = background?.items.filter(item => item.active) ?? [];
  if (!active.length) return '';
  const kinds = new Set(active.map(item => item.kind));
  const noun = kinds.size > 1 ? 'background tasks' : active[0].kind === 'workflow' ? 'workflow' : 'subagent';
  return `${active.length} ${noun}${active.length > 1 && kinds.size === 1 ? 's' : ''} running`;
}

/** The count in the thread header; spins while anything runs. */
export function BackgroundButton(props: {background?: ThreadBackground; open: () => void}) {
  const items = props.background?.items ?? [];
  if (!items.length) return null;
  const active = props.background!.active;
  return (
    <button
      className={'icon-button background-button' + (active ? ' active' : '')}
      title={active ? backgroundLabel(props.background) : 'Background work in this thread'}
      aria-label={active ? backgroundLabel(props.background) : 'Background work'}
      onClick={props.open}
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="M6 8.5v1.5a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V8.5M12 13v2.5" />
      </svg>
      {active > 0 && <span className="files-count">{active}</span>}
    </button>
  );
}

/** A strip above the message box while background work runs. */
export function BackgroundStrip(props: {background?: ThreadBackground; open: () => void}) {
  const label = backgroundLabel(props.background);
  if (!label) return null;
  const names = props.background!.items.filter(item => item.active).map(item => item.title);
  return (
    <button className="background-strip" onClick={props.open}>
      <i className="background-spinner" aria-hidden="true" />
      <strong>{label}</strong>
      <span>{names.slice(0, 3).join(', ')}</span>
      <em>View</em>
    </button>
  );
}

function Row(props: {item: BackgroundItem; open: () => void}) {
  const {item} = props;
  const meta = [duration(item), item.progress, tokens(item.tokens), money(item.cost)].filter(Boolean).join(' · ');
  return (
    <li>
      <button className="background-row" onClick={props.open}>
        <span className="background-row-head">
          <span className={'background-kind ' + item.kind}>{KIND[item.kind]}</span>
          <strong>{item.title}</strong>
          <span className={'background-state ' + item.state}>
            {item.active && item.state === 'running' && <i className="background-spinner" aria-hidden="true" />}
            {STATE[item.state]}
          </span>
        </span>
        {(item.task || item.phase) && <span className="background-task">{item.phase ? `${item.phase}${item.task ? ' · ' : ''}` : ''}{item.task}</span>}
        {meta && <small>{meta}</small>}
      </button>
    </li>
  );
}

function DetailView(props: {threadId: string; item: BackgroundItem; api: Api}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const out = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      props
        .api(`/threads/${props.threadId}/background/${props.item.kind}/${encodeURIComponent(props.item.id)}`)
        .then(next => live && setDetail(next))
        .catch(e => live && setError(e.message));
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [props.item.id]);
  // Follow the newest output, unless the owner has scrolled up to read.
  useEffect(() => {
    const el = out.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [detail?.output]);
  const item = detail ?? props.item;
  return (
    <div className="background-detail">
      <span className="background-row-head">
        <span className={'background-kind ' + item.kind}>{KIND[item.kind]}</span>
        <strong>{item.title}</strong>
        <span className={'background-state ' + item.state}>
          {item.active && item.state === 'running' && <i className="background-spinner" aria-hidden="true" />}
          {STATE[item.state]}
        </span>
      </span>
      <small className="muted">{[duration(item), item.progress, tokens(item.tokens), money(item.cost)].filter(Boolean).join(' · ')}</small>
      {item.phase && <p className="background-phase">Phase: {item.phase}</p>}
      {!!item.labels?.length && <p className="background-phase">Working on: {item.labels.join(', ')}</p>}
      {item.task && <p className="background-full-task">{item.task}</p>}
      {!!detail?.steps?.length && detail.steps.length > 1 && (
        <ol className="background-steps">
          {detail.steps.map((step, i) => (
            <li key={i}>
              <span>{step.agent}</span>
              <small>{step.status}</small>
            </li>
          ))}
        </ol>
      )}
      <h4>Output</h4>
      {error ? (
        <p className="run-error">{error}</p>
      ) : (
        <pre ref={out} className="background-output">
          {detail ? detail.output || 'No output yet.' : 'Loading…'}
        </pre>
      )}
    </div>
  );
}

/** The panel: every background run of this thread, and one run's details. */
export function BackgroundPanel(props: {threadId: string; api: Api; close: () => void; report: (e: any) => void}) {
  const [data, setData] = useState<{items: BackgroundItem[]; alive: boolean} | null>(null);
  const [open, setOpen] = useState<BackgroundItem | null>(null);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      props
        .api(`/threads/${props.threadId}/background`)
        .then(next => live && setData(next))
        .catch(props.report);
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && (open ? setOpen(null) : props.close());
    window.addEventListener('keydown', onKey);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [props.threadId, open]);
  const active = data?.items.filter(item => item.active) ?? [];
  const stop = async () => {
    if (!confirm(`Stop ${active.length === 1 ? 'this background task' : `all ${active.length} background tasks`}? Their work so far is kept, but they will not finish or report back.`)) return;
    setStopping(true);
    try {
      setData(await props.api(`/threads/${props.threadId}/background/stop`, {}));
    } catch (e) {
      props.report(e);
    } finally {
      setStopping(false);
    }
  };
  return createPortal(
    <div className="modal-backdrop" onClick={props.close}>
      <section className="preview files-panel background-panel" role="dialog" aria-modal="true" aria-label="Background work" onClick={e => e.stopPropagation()}>
        <header>
          {open ? (
            <button className="quiet" onClick={() => setOpen(null)}>
              ← Background
            </button>
          ) : (
            <span className="eyebrow">BACKGROUND · {active.length} RUNNING</span>
          )}
          <button onClick={props.close} aria-label="Close background work">
            ×
          </button>
        </header>
        <div className="files-body">
          {open ? (
            <DetailView threadId={props.threadId} item={data?.items.find(item => item.id === open.id) ?? open} api={props.api} />
          ) : !data ? (
            <p className="file-note">Loading…</p>
          ) : data.items.length ? (
            <ul className="background-list">
              {data.items.map(item => (
                <Row key={item.kind + item.id} item={item} open={() => setOpen(item)} />
              ))}
            </ul>
          ) : (
            <p className="file-note">
              Nothing in the background. Subagents and workflows the agent starts in the background show up here, and Muster keeps Pi running
              until they finish and report back.
            </p>
          )}
        </div>
        {!open && active.length > 0 && data?.alive && (
          <footer className="background-footer">
            <small className="muted">Their results come back to this thread when they finish.</small>
            <button className="danger-button" disabled={stopping} onClick={() => void stop()}>
              {stopping ? 'Stopping…' : active.length === 1 ? 'Stop it' : 'Stop all'}
            </button>
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}
