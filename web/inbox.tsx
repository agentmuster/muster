import {useState} from 'react';

// The Inbox tab: messages from module feeds, such as Teams, grouped by the model into requests (what someone
// needs the owner to do or answer). Messages that ask for nothing are kept in a collapsed list.

export type InboxItem = {
  key: string;
  module: string;
  source: string;
  id: string;
  title: string;
  text: string;
  author?: string;
  time: string;
  url?: string;
  place?: string;
  context?: string;
  read: boolean;
  thread?: string;
};
export type InboxRequest = {
  id: string;
  title: string;
  summary: string;
  people: string[];
  items: string[];
  priority: 'high' | 'normal' | 'low';
  kind: string;
  status: 'open' | 'done';
  thread?: string;
  latest: number;
  unread: boolean;
};
export type InboxFeed = {key: string; title: string; every: number; lastAt?: number; ok?: boolean; error?: string; running?: boolean};
export type InboxData = {
  items: InboxItem[];
  unread: number;
  feeds: InboxFeed[];
  requests: InboxRequest[];
  pending: number;
  ignored: string[];
  triage: {running: boolean; lastAt?: number; ok?: boolean; error?: string};
  /** The server does not group messages yet (it has not restarted since the update). */
  legacy?: boolean;
};

/** Fills in fields an older server leaves out, so the page works across a server update. */
export const fillInbox = (data: any): InboxData => ({
  items: [],
  unread: 0,
  feeds: [],
  requests: [],
  pending: 0,
  ignored: [],
  ...data,
  triage: {running: false, ...(data?.triage ?? {})},
  legacy: !data?.triage,
});

/** Open requests with something unread: the number on the Inbox tab. */
export const newRequests = (data: InboxData | null) => data?.requests.filter(r => r.status === 'open' && r.unread).length ?? 0;

const when = (time: string | number) => {
  const at = typeof time === 'number' ? time : Date.parse(time);
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
};
const quote = (text: string) => text.split('\n').map(line => '> ' + line).join('\n');
const where = (item: InboxItem) => (item.place && item.place !== 'Direct message' ? item.place : 'direct message');

/** What goes in the message box when a session starts from a request: the ask, then the messages behind it. */
export function requestPrefill(request: InboxRequest, messages: InboxItem[]) {
  const source = messages[0]?.source ?? 'Inbox';
  const lines = [`Request from ${request.people.join(', ') || 'a colleague'} via ${source}: ${request.title}`];
  if (request.summary) lines.push('', request.summary);
  lines.push('', 'Messages:');
  for (const item of messages) {
    lines.push('', `${item.author ?? 'Someone'} (${where(item)}, ${new Date(item.time).toLocaleString()}):`, quote(item.text));
  }
  const links = [...new Set(messages.map(item => item.url).filter((url): url is string => !!url))];
  if (links.length) lines.push('', 'Links:', ...links);
  lines.push('', '');
  return lines.join('\n');
}

function Message({item}: {item: InboxItem}) {
  return (
    <li className="inbox-message">
      <span className="inbox-meta">
        <strong>{item.author ?? 'Someone'}</strong>
        <span>{where(item)}</span>
        <span className="inbox-time">{when(item.time)}</span>
        {item.url && (
          <a href={item.url} target="_blank" rel="noopener" title={`Open in ${item.source}`}>
            ↗
          </a>
        )}
      </span>
      <span className="inbox-text">{item.text}</span>
    </li>
  );
}

export function InboxList(props: {
  data: InboxData | null;
  refresh: () => void;
  regroup: () => void;
  markRequest: (id: string, change: {status?: 'open' | 'done'}) => void;
  start: (request: InboxRequest, messages: InboxItem[]) => Promise<void>;
  openThread: (id: string) => void;
}) {
  const {data} = props;
  const [open, setOpen] = useState('');
  const [starting, setStarting] = useState('');
  const [showDone, setShowDone] = useState(false);
  if (!data) return <p className="muted">Loading…</p>;
  const items = new Map(data.items.map(item => [item.key, item]));
  const checking = data.feeds.some(feed => feed.running);
  const failed = data.feeds.filter(feed => feed.ok === false && feed.error);
  const last = Math.max(0, ...data.feeds.map(feed => feed.lastAt ?? 0));
  const requests = data.requests.filter(request => (showDone ? request.status === 'done' : request.status === 'open'));
  const doneCount = data.requests.filter(request => request.status === 'done').length;
  const ignored = data.ignored.map(key => items.get(key)).filter((item): item is InboxItem => !!item);
  const status = data.triage.running
    ? 'Grouping new messages…'
    : checking
      ? 'Checking…'
      : last
        ? `Checked ${when(last)}`
        : 'Not checked yet';
  return (
    <div className="inbox">
      <div className="inbox-bar">
        <small className="muted">{status}</small>
        <button className="quiet" disabled={checking || data.triage.running} onClick={props.refresh}>
          Refresh
        </button>
        {(doneCount > 0 || showDone) && (
          <button className={'quiet' + (showDone ? ' on' : '')} aria-pressed={showDone} onClick={() => setShowDone(value => !value)}>
            Done {doneCount}
          </button>
        )}
      </div>
      {failed.map(feed => (
        <p key={feed.key} className="inbox-error">
          {feed.title}: {feed.error}
        </p>
      ))}
      {data.triage.ok === false && data.pending > 0 && !data.triage.running && (
        <p className="inbox-error">
          Grouping failed: {data.triage.error}{' '}
          <button className="quiet" onClick={props.regroup}>
            Try again
          </button>
        </p>
      )}
      {data.pending > 0 && (
        <p className="muted inbox-pending">
          {data.pending} new {data.pending === 1 ? 'message' : 'messages'} {data.triage.running ? 'being grouped…' : 'not grouped yet.'}
        </p>
      )}
      {data.legacy && (
        <>
          <p className="muted inbox-pending">Grouping into requests starts after Muster restarts. Until then, the messages:</p>
          <ul className="inbox-messages">
            {data.items.slice(0, 60).map(item => (
              <Message key={item.key} item={item} />
            ))}
          </ul>
        </>
      )}
      {!data.legacy && !requests.length && (
        <p className="muted">
          {showDone ? 'No finished requests.' : checking || !last ? 'Looking for messages…' : 'Nothing anyone needs from you right now.'}
        </p>
      )}
      {requests.map(request => {
        const messages = request.items
          .map(key => items.get(key))
          .filter((item): item is InboxItem => !!item)
          .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
        const expanded = open === request.id;
        const latest = messages.at(-1);
        return (
          <article
            key={request.id}
            className={'inbox-item request ' + request.priority + (request.unread && request.status === 'open' ? ' unread' : '') + (request.status === 'done' ? ' done' : '')}
          >
            <span className="inbox-meta">
              {request.priority === 'high' && <span className="priority">Urgent</span>}
              <span className="kind">{request.kind}</span>
              <span className="people">{request.people.join(', ')}</span>
              <span className="inbox-time">{when(request.latest)}</span>
            </span>
            <strong className="request-title">
              {request.unread && request.status === 'open' && <i className="inbox-dot" aria-label="New" />}
              {request.title}
            </strong>
            {request.summary && <p className="request-summary">{request.summary}</p>}
            <button className="quiet request-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? '' : request.id)}>
              {messages.length} {messages.length === 1 ? 'message' : 'messages'} {expanded ? '▴' : '▾'}
            </button>
            {expanded && (
              <ul className="inbox-messages">
                {messages.map(item => (
                  <Message key={item.key} item={item} />
                ))}
              </ul>
            )}
            <div className="inbox-actions">
              {request.thread ? (
                <button className="quiet" onClick={() => props.openThread(request.thread!)}>
                  Open session
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!!starting}
                  onClick={async () => {
                    setStarting(request.id);
                    try {
                      await props.start(request, messages);
                    } finally {
                      setStarting('');
                    }
                  }}
                >
                  {starting === request.id ? 'Starting…' : 'Start session'}
                </button>
              )}
              {latest?.url && (
                <a className="button-link" href={latest.url} target="_blank" rel="noopener" title={`Open in ${latest.source}`}>
                  {latest.source} ↗
                </a>
              )}
              <button
                className="icon-button inbox-read"
                title={request.status === 'done' ? 'Reopen' : 'Done'}
                aria-label={request.status === 'done' ? 'Reopen' : 'Mark done'}
                onClick={() => props.markRequest(request.id, {status: request.status === 'done' ? 'open' : 'done'})}
              >
                {request.status === 'done' ? '↺' : '✓'}
              </button>
            </div>
          </article>
        );
      })}
      {ignored.length > 0 && !showDone && (
        <details className="inbox-other">
          <summary>
            Other messages {ignored.length} <small>thanks, updates, FYIs</small>
          </summary>
          <ul className="inbox-messages">
            {ignored.slice(0, 60).map(item => (
              <Message key={item.key} item={item} />
            ))}
          </ul>
        </details>
      )}
      <small className="muted inbox-note">Messages are sent to your default Pi model to group them into requests.</small>
    </div>
  );
}
