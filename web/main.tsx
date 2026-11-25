import {createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {CopilotKit} from '@copilotkit/react-core';
import {AssistantMessage, CopilotChat, ImageRenderer, Markdown, UserMessage} from '@copilotkit/react-ui';
import '@copilotkit/react-ui/styles.css';
import './style.css';
import {appendDictation, Dictation, recognitionConstructor, type DictationState} from './dictation';
import {ActionsPanel, ModulesSettings, type ModuleInfo} from './modules';
import {InboxList, fillInbox, newRequests, requestPrefill, type InboxData, type InboxItem, type InboxRequest} from './inbox';
import {sessionPrUrls} from '../shared/pr-links';
import {QuestionCard, type PendingQuestion} from './question';
import {BackgroundButton, BackgroundPanel, BackgroundStrip, backgroundLabel, type ThreadBackground} from './background';
const PullRequestsPanel = lazy(() => import('./pull-requests'));

type Chunk = {line: number; role: string; text: string; branch: string};
type Source = {
  id: string;
  engine: string;
  title: string;
  cwd: string;
  path: string;
  modified: number;
  excerpt: string;
  sidechain: number;
  ticket?: boolean;
  chunks?: Chunk[];
};
type ModelList = {
  defaults: {model: string; thinking: string};
  thinkingLevels: string[];
  models: {id: string; provider: string; model: string; thinking: boolean}[];
};
type SharedFile = {
  id: string;
  path: string;
  name: string;
  size: number;
  mtime: number;
  added: number;
  via: string;
  kind?: 'change' | 'artifact';
  created?: boolean;
  linesAdded?: number;
  linesRemoved?: number;
};
type FileDiff = {patch: string; added: number; removed: number; created: boolean};
// diff2html and highlight.js load only when a diff is opened.
const DiffView = lazy(() => import('./diff-view'));
// xterm.js loads only when the terminal is opened.
const TerminalPanel = lazy(() => import('./terminal').then(module => ({default: module.TerminalPanel})));
type Attention = {kind: 'help' | 'question' | 'queue' | 'reply' | 'stopped'; label: string; at: number};
type Notice = {id: string; thread: string; title: string; attention: Attention};
type QueuedMessage = {id: string; text: string; parts: any[]; model?: string; created: number; steering?: boolean};
type Run = {id: string; status: string; activity: string; error?: string; truncated?: boolean; task?: 'compact' | 'stats'};
type Thread = {
  background?: ThreadBackground;
  question?: PendingQuestion;
  id: string;
  title: string;
  cwd: string;
  messages: any[];
  sources: string[];
  context: any[];
  automatic: boolean;
  run?: Run;
  model?: string;
  thinking?: string;
  origin?: {action: string; engine: string; title: string; path: string};
  contextUsage?: {tokens: number | null; contextWindow: number | null; percent: number | null; at: number};
  queue?: QueuedMessage[];
  /** Set in the thread list when the thread is waiting on you. */
  attention?: Attention;
  seenAt?: number;
  queueHeld?: boolean;
  files?: SharedFile[];
};

async function api(url: string, body?: unknown) {
  const init: RequestInit =
    body === undefined
      ? {credentials: 'same-origin'}
      : {
          credentials: 'same-origin',
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(body),
        };
  let response: Response;
  try {
    response = await fetch('/api' + url, init);
  } catch (error) {
    await accessExpired();
    throw error;
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('signed-out'));
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

let reloading = false;
/**
 * When the Cloudflare Access session ends, Cloudflare answers API calls with a redirect to its sign-in
 * page, which fetch reports as a network error. A reload shows that sign-in page instead.
 */
async function accessExpired() {
  if (reloading || location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  try {
    const probe = await fetch('/api/health', {redirect: 'manual', cache: 'no-store'});
    if (probe.type === 'opaqueredirect') {
      reloading = true;
      location.reload();
    }
  } catch {
    // Offline; nothing to do until the connection returns.
  }
}

/** A setting saved in this browser, so each device keeps its own choices. */
function usePref<T>(key: string, initial: T) {
  const storageKey = 'muster.' + key;
  const [value, setValue] = useState<T>(() => {
    try {
      // Settings saved before the rename to Muster are carried over once.
      const raw = localStorage.getItem(storageKey) ?? localStorage.getItem('sessionDesk.' + key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // Private browsing can refuse storage; the setting then lasts for this page only.
    }
  }, [storageKey, value]);
  return [value, setValue] as const;
}

const DisplayPrefs = createContext({thinking: false, tools: false});

function parseArgs(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** One line that says what a tool call did, e.g. the shell command or file path. */
function toolBrief(name: string, args: any) {
  if (!args || typeof args !== 'object') return String(args ?? '');
  const pick = args.command ?? args.path ?? args.file_path ?? args.url ?? args.pattern ?? args.query;
  const text = name === 'browseros' ? [args.action, args.url ?? args.selector].filter(Boolean).join(' ') : pick;
  const brief = typeof text === 'string' ? text : Object.values(args).find(value => typeof value === 'string');
  return String(brief ?? '').replace(/\s+/g, ' ').slice(0, 140);
}

/**
 * Until November 24, 2026 the server could not read the data folder under ~/.local and answered image
 * requests with a 404 that browsers kept for a day. The suffix gives every upload link a new address, so
 * those stored errors are skipped. The server ignores it.
 */
const freshImageLink = (src: string) => (/^\/api\/uploads\/[^?]+$/.test(src) ? src + '?v=2' : src);
function withFreshImageLinks(message: any) {
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((part: any) =>
      part?.type === 'image' && typeof part.source?.value === 'string' && part.source.type === 'url'
        ? {...part, source: {...part.source, value: freshImageLink(part.source.value)}}
        : part,
    ),
  };
}

/** Image links the server puts at the start of a tool result, one per line. */
const TOOL_IMAGE = /^\[image: (\/api\/uploads\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp))\]$/;

function splitToolImages(result: string | undefined) {
  if (result === undefined) return {text: undefined, images: [] as string[]};
  const error = result.startsWith('Error: ');
  const lines = (error ? result.slice(7) : result).split('\n');
  const images: string[] = [];
  while (lines.length && TOOL_IMAGE.test(lines[0])) images.push(lines.shift()!.match(TOOL_IMAGE)![1]);
  return {text: (error ? 'Error: ' : '') + lines.join('\n'), images};
}

function ToolCall({call, result, running}: {call: any; result?: string; running: boolean}) {
  const name = String(call.function?.name ?? 'tool');
  const args = parseArgs(String(call.function?.arguments ?? '{}'));
  const {text, images} = splitToolImages(result);
  const failed = result?.startsWith('Error: ');
  const state = result === undefined ? (running ? 'running' : 'no result') : failed ? 'failed' : 'done';
  return (
    <div className="tool-call-wrap">
      <details className={'tool-call ' + state.replace(' ', '-')}>
        <summary>
          <span className="tool-name">{name}</span>
          <span className="tool-brief">{toolBrief(name, args)}</span>
          <span className="tool-state">{state}</span>
        </summary>
        <pre className="tool-args">{typeof args === 'string' ? args : JSON.stringify(args, null, 2)}</pre>
        {text !== undefined && <pre className="tool-output">{text}</pre>}
      </details>
      {/* What the agent saw, visible without opening the call. Tap for full screen. */}
      {images.length > 0 && (
        <div className="tool-images">
          {images.map(src => (
            <img key={src} src={freshImageLink(src)} alt={`Image returned by ${name}`} loading="lazy" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Renders chat messages, including Pi's thinking and tool calls when the owner has turned them on.
 * Tool results are shown inside the matching call, so 'tool' messages render nothing themselves.
 */
// Pasted text

/** A paste this long becomes a snippet in the message box instead of filling it. */
const isLargePaste = (text: string) => text.length > 2000 || text.split('\n').length > 30;
/** A sent message this long shows as a card even without the pasted marker. */
const isLongMessage = (text: string) => text.length > 4000 || text.split('\n').length > 40;

/**
 * Wraps pasted text in a fenced block marked "pasted", so the agent sees it as pasted content and the chat
 * can show it as a card. The fence is longer than any run of backticks inside, so pasted code cannot end it.
 */
function fencePasted(text: string) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(4, longest + 1));
  return `${fence}pasted\n${text.replace(/\n+$/, '')}\n${fence}`;
}

type Segment = {kind: 'text'; text: string} | {kind: 'snippet'; text: string; label: string};

/** Splits a message into its own words and the pasted blocks inside it. */
function splitPasted(content: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /^(`{4,})pasted[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm;
  let last = 0;
  for (const match of content.matchAll(pattern)) {
    const before = content.slice(last, match.index).trim();
    if (before) segments.push({kind: 'text', text: before});
    segments.push({kind: 'snippet', text: match[2], label: 'Pasted text'});
    last = match.index! + match[0].length;
  }
  const rest = content.slice(last).trim();
  if (rest) segments.push({kind: 'text', text: rest});
  if (!segments.some(segment => segment.kind === 'snippet') && isLongMessage(content)) {
    return [{kind: 'snippet', text: content, label: 'Long message'}];
  }
  return segments;
}

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((part: any) => part?.type === 'text')
          .map((part: any) => part.text)
          .join('\n')
      : '';

function snippetSize(text: string) {
  const lines = text.split('\n').length;
  return `${lines.toLocaleString()} line${lines === 1 ? '' : 's'} · ${sizeLabel(new Blob([text]).size)}`;
}

/** The whole snippet, readable and copyable, over the chat. */
function SnippetModal(props: {label: string; text: string; close: () => void}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.close]);
  const copy = () =>
    void navigator.clipboard?.writeText(props.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return createPortal(
    <div className="snippet-backdrop" onClick={props.close}>
      <section className="snippet-modal" role="dialog" aria-modal="true" aria-label={props.label} onClick={e => e.stopPropagation()}>
        <header>
          <div>
            <strong>{props.label}</strong>
            <small>{snippetSize(props.text)}</small>
          </div>
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button className="icon-button" aria-label="Close" onClick={props.close}>
            ×
          </button>
        </header>
        <pre>{props.text}</pre>
      </section>
    </div>,
    document.body,
  );
}

/** A long paste in a message: its first lines and size; tap for the whole text. */
function SnippetCard({label, text}: {label: string; text: string}) {
  const [open, setOpen] = useState(false);
  const preview = text.split('\n').slice(0, 6).join('\n');
  return (
    <>
      <button className="snippet-card" onClick={() => setOpen(true)} title="Show the whole text">
        <span className="snippet-head">
          <b>{label}</b>
          <small>{snippetSize(text)}</small>
        </span>
        <pre>{preview}</pre>
        <span className="snippet-more">Show all</span>
      </button>
      {open && <SnippetModal label={label} text={text} close={() => setOpen(false)} />}
    </>
  );
}

function ChatMessage(props: any) {
  const prefs = useContext(DisplayPrefs);
  const queueing = useContext(QueueContext);
  let {message} = props;
  const {messages, inProgress, index, isCurrentMessage} = props;
  const Assistant = props.AssistantMessage ?? AssistantMessage;
  const User = props.UserMessage ?? UserMessage;
  const Images = props.ImageRenderer ?? ImageRenderer;

  if (message.role === 'user') {
    message = withFreshImageLinks(message);
    const segments = splitPasted(textOf(message.content));
    if (!segments.some(segment => segment.kind === 'snippet')) {
      return <User key={index} rawData={message} data-message-role="user" message={message} ImageRenderer={Images} />;
    }
    const media = Array.isArray(message.content) ? message.content.filter((part: any) => part?.type !== 'text') : [];
    return (
      <>
        <div key={index} className="copilotKitMessage copilotKitUserMessage with-snippets" data-message-role="user">
          {segments.map((segment, at) =>
            segment.kind === 'text' ? (
              <div key={at} className="user-text">
                {segment.text}
              </div>
            ) : (
              <SnippetCard key={at} label={segment.label} text={segment.text} />
            ),
          )}
        </div>
        {media.length > 0 && <User rawData={message} message={{...message, content: media}} ImageRenderer={Images} />}
      </>
    );
  }
  if (message.role === 'reasoning') {
    if (!prefs.thinking || !String(message.content ?? '').trim()) return null;
    const live = inProgress && isCurrentMessage;
    return (
      // Open by default; collapsing it stays collapsed because the open prop never changes.
      <details className="thinking" open>
        <summary>{live ? 'Thinking…' : 'Thinking'}</summary>
        <div className="thinking-body">
          <Markdown content={String(message.content)} />
        </div>
      </details>
    );
  }
  if (message.role !== 'assistant') return null;

  const calls: any[] = message.toolCalls ?? [];
  const results = new Map<string, string>();
  for (const other of messages) if (other.role === 'tool') results.set(other.toolCallId, String(other.content ?? ''));
  const hasText = typeof message.content === 'string' && message.content.trim() !== '';
  const pending = calls.filter(call => !results.has(call.id));
  const working = inProgress && pending.length > 0;

  return (
    <>
      {(hasText || (!calls.length && inProgress && isCurrentMessage)) && (
        <Assistant
          key={index}
          data-message-role="assistant"
          subComponent={message.generativeUI?.()}
          rawData={message}
          message={message}
          messages={messages}
          isLoading={inProgress && isCurrentMessage && !message.content}
          isGenerating={inProgress && isCurrentMessage && !!message.content}
          isCurrentMessage={isCurrentMessage}
          // CopilotKit's regenerate only trims the chat; Pi would still see the old reply. This button retries
          // on a Pi branch instead. Thumbs up and down are left out: they recorded nothing.
          onRegenerate={() => queueing.retry?.()}
          onCopy={props.onCopy}
          feedback={props.messageFeedback?.[message.id] || null}
          markdownTagRenderers={props.markdownTagRenderers}
          ImageRenderer={Images}
        />
      )}
      {prefs.tools && calls.length > 0 && (
        <div className="tool-calls">
          {calls.map(call => (
            <ToolCall key={call.id} call={call} result={results.get(call.id)} running={inProgress} />
          ))}
        </div>
      )}
      {!prefs.tools && working && (
        <p className="tool-working">Running {pending.map(call => call.function?.name).join(', ')}…</p>
      )}
    </>
  );
}

/** Model and thinking level for this device's next runs. Empty values use the Pi defaults. */
function ModelPicker(props: {
  models: ModelList | null;
  model: string;
  thinking: string;
  setModel: (value: string) => void;
  setThinking: (value: string) => void;
}) {
  const {models} = props;
  const groups = new Map<string, ModelList['models']>();
  for (const item of models?.models ?? []) {
    if (!groups.has(item.provider)) groups.set(item.provider, []);
    groups.get(item.provider)!.push(item);
  }
  // Large catalogs such as OpenRouter go last so direct providers stay near the top.
  const providers = [...groups.keys()].sort((a, b) => groups.get(a)!.length - groups.get(b)!.length || a.localeCompare(b));
  const known = !props.model || models?.models.some(item => item.id === props.model);
  return (
    <div className="model-picker">
      <label>
        <span>Model</span>
        <select value={props.model} onChange={e => props.setModel(e.target.value)} disabled={!models}>
          <option value="">{models ? `Pi default · ${models.defaults.model || 'not set'}` : 'Loading models…'}</option>
          {!known && <option value={props.model}>{props.model} (unavailable)</option>}
          {providers.map(provider => (
            <optgroup key={provider} label={provider}>
              {groups.get(provider)!.map(item => (
                <option key={item.id} value={item.id}>
                  {item.model}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        <span>Thinking</span>
        <select value={props.thinking} onChange={e => props.setThinking(e.target.value)}>
          <option value="">Pi default{models?.defaults.thinking ? ` · ${models.defaults.thinking}` : ''}</option>
          {(models?.thinkingLevels ?? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).map(level => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <small>Applies to the next message on this device.</small>
    </div>
  );
}

/** Fills the chat box once, without sending, so the owner can edit the request first. */
function Prefill({text, done}: {text: string; done: () => void}) {
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      const box = document.querySelector<HTMLTextAreaElement>('.copilotKitInput textarea');
      if (box || ++tries > 30) clearInterval(timer);
      if (!box) return;
      if (!box.value) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
        box.dispatchEvent(new Event('input', {bubbles: true}));
        box.focus();
      }
      done();
    }, 100);
    return () => clearInterval(timer);
  }, [text]);
  return null;
}

type FinderMatch = {
  id: string;
  why: string;
  state: string;
  action: 'continue' | 'split' | 'new';
  engine: string;
  title: string;
  cwd: string;
  modified: number;
  canContinue: boolean;
  recentlyActive: boolean;
};
type FinderState = {
  id: string;
  query: string;
  status: 'running' | 'done' | 'failed';
  steps: {at: number; text: string}[];
  summary?: string;
  matches?: FinderMatch[];
  error?: string;
};

/**
 * The chat box. It keeps CopilotKit's structure and class names (its paste handler looks for a textarea
 * directly inside .copilotKitInput) but also allows sending images without any text.
 */
/** What the chat box needs to queue messages while the thread is busy. */
const QueueContext = createContext<{
  busy: boolean;
  enqueue: (text: string, images: any[]) => Promise<void>;
  /** Runs the last message again on a branch without the reply it got. */
  retry?: () => void;
  /** The thread's queued messages, shown just above the box. */
  panel?: React.ReactNode;
  /** Slash commands this thread's Pi accepts, for the / menu. */
  commands?: SlashCommand[];
}>({
  busy: false,
  enqueue: async () => {},
});

type SlashCommand = {name: string; description: string; source: string};
const COMMAND_KIND: Record<string, string> = {skill: 'Skill', prompt: 'Prompt', extension: 'Command'};

/** Commands matching what follows the /, names that start with it first. */
export function matchCommands(commands: SlashCommand[], query: string) {
  const q = query.toLowerCase();
  const score = (c: SlashCommand) => {
    const name = c.name.toLowerCase();
    const bare = name.replace(/^skill:/, '');
    if (!q) return 0;
    if (name.startsWith(q) || bare.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (c.description.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return commands
    .map(c => ({c, s: score(c)}))
    .filter(entry => entry.s >= 0)
    .sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name))
    .map(entry => entry.c)
    .slice(0, 60);
}

/** The / menu above the message box. */
function SlashMenu(props: {items: SlashCommand[]; active: number; pick: (c: SlashCommand) => void; hover: (i: number) => void}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${props.active}"]`)?.scrollIntoView({block: 'nearest'});
  }, [props.active]);
  return (
    <ul className="slash-menu" role="listbox" aria-label="Commands" ref={list}>
      {props.items.length ? (
        props.items.map((command, index) => (
          <li
            key={command.name}
            data-index={index}
            role="option"
            aria-selected={index === props.active}
            className={index === props.active ? 'active' : ''}
            onMouseEnter={() => props.hover(index)}
            onMouseDown={event => {
              // Keep focus in the box.
              event.preventDefault();
              props.pick(command);
            }}
          >
            <span className="slash-name">/{command.name}</span>
            <span className="slash-kind">{COMMAND_KIND[command.source] ?? command.source}</span>
            {command.description && <small>{command.description}</small>}
          </li>
        ))
      ) : (
        <li className="slash-empty">No matching commands</li>
      )}
    </ul>
  );
}

/** Images waiting in CopilotKit's attachment queue, as AG-UI image parts; the queue is then cleared. */
function takeAttachments() {
  const images = [...document.querySelectorAll<HTMLImageElement>('.copilotKitAttachmentQueueItem img')]
    .map(img => /^data:([^;]+);base64,(.+)$/.exec(img.getAttribute('src') || ''))
    .filter((match): match is RegExpExecArray => !!match)
    .map(match => ({type: 'image', source: {type: 'data', value: match[2], mimeType: match[1]}}));
  return {
    images,
    clear: () =>
      document.querySelectorAll<HTMLButtonElement>('.copilotKitAttachmentQueueRemoveButton').forEach(button => button.click()),
  };
}

/**
 * The chat box. It keeps CopilotKit's structure and class names (its paste handler looks for a textarea
 * directly inside .copilotKitInput), allows sending images without text, and while a reply is running
 * it queues messages on the server instead of refusing or dropping them.
 */
function ChatInput(props: {
  inProgress: boolean;
  onSend: (text: string) => Promise<unknown>;
  onStop?: () => void;
  onUpload?: () => void;
  hideStopButton?: boolean;
  chatReady?: boolean;
}) {
  const queueing = useContext(QueueContext);
  const [text, setText] = useState('');
  // Large pastes wait beside the box as snippets and are added to the message when it is sent.
  const [snippets, setSnippets] = useState<{id: string; text: string}[]>([]);
  const [viewing, setViewing] = useState<{id: string; text: string} | null>(null);
  const [attached, setAttached] = useState(0);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const voice = useRef<Dictation | null>(null);
  const [dictation, setDictation] = useState<DictationState>({phase: 'idle', interim: '', error: ''});
  const recording = dictation.phase !== 'idle';

  // The / menu: open while the box holds only "/word", until a command is picked or Escape closes it.
  const slash = /^\/(\S*)$/.exec(text);
  const [menuClosed, setMenuClosed] = useState('');
  const [menuActive, setMenuActive] = useState(0);
  const menuItems = slash && queueing.commands && menuClosed !== text ? matchCommands(queueing.commands, slash[1]) : null;
  useEffect(() => setMenuActive(0), [slash?.[1]]);
  const pickCommand = (command: SlashCommand) => {
    setText('/' + command.name + ' ');
    setMenuClosed('');
    box.current?.focus();
  };

  useEffect(() => {
    const session = new Dictation(
      recognitionConstructor(),
      words => setText(draft => appendDictation(draft, words)),
      setDictation,
      navigator.language || 'en-US',
    );
    voice.current = session;
    const hide = () => {
      if (document.visibilityState === 'hidden') session.cancel();
    };
    const leave = () => session.cancel();
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave);
    return () => {
      session.dispose();
      voice.current = null;
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', leave);
    };
  }, []);

  // CopilotKit keeps attached images to itself; count them from its attachment queue.
  useEffect(() => {
    const count = () => setAttached(document.querySelectorAll('.copilotKitAttachmentQueueItem').length);
    count();
    const observer = new MutationObserver(count);
    observer.observe(document.body, {childList: true, subtree: true});
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  // Busy when this chat is streaming, or the server is running the thread (a queued message, another device).
  const busy = props.inProgress || queueing.busy;
  const hasContent = text.trim().length > 0 || attached > 0 || snippets.length > 0;
  const canSend = props.chatReady !== false && hasContent && !saving && !recording;
  const message = () => [text.trim(), ...snippets.map(snippet => fencePasted(snippet.text))].filter(Boolean).join('\n\n');
  const send = async () => {
    if (!canSend) return;
    if (!busy) {
      void props.onSend(message());
      setText('');
      setSnippets([]);
      box.current?.focus();
      return;
    }
    const {images, clear} = takeAttachments();
    setSaving(true);
    try {
      await queueing.enqueue(message(), images);
      setText('');
      setSnippets([]);
      clear();
    } finally {
      setSaving(false);
      box.current?.focus();
    }
  };
  const showStop = busy && !props.hideStopButton && !!props.onStop && props.inProgress;

  return (
    <div className="copilotKitInputContainer">
      {queueing.panel}
      <div
        className="copilotKitInput"
        onClick={event => {
          const target = event.target as HTMLElement;
          if (!target.closest('button') && target.tagName !== 'TEXTAREA') box.current?.focus();
        }}
      >
        {snippets.length > 0 && (
          <div className="snippet-chips">
            {snippets.map(snippet => (
              <span key={snippet.id} className="snippet-chip">
                <button className="snippet-chip-open" onClick={() => setViewing(snippet)} title="Preview the pasted text">
                  <b>Pasted text</b>
                  <small>{snippetSize(snippet.text)}</small>
                </button>
                <button
                  className="snippet-chip-remove"
                  aria-label="Remove pasted text"
                  onClick={() => setSnippets(list => list.filter(item => item.id !== snippet.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {viewing && <SnippetModal label="Pasted text" text={viewing.text} close={() => setViewing(null)} />}
        {menuItems && <SlashMenu items={menuItems} active={menuActive} pick={pickCommand} hover={setMenuActive} />}
        <textarea
          ref={box}
          rows={1}
          value={text}
          onPaste={event => {
            // Images are CopilotKit's; only large plain text becomes a snippet.
            if (event.clipboardData.files.length) return;
            const pasted = event.clipboardData.getData('text/plain');
            if (!isLargePaste(pasted)) return;
            event.preventDefault();
            setSnippets(list => [...list, {id: crypto.randomUUID(), text: pasted}]);
          }}
          placeholder={busy ? 'Queue a message for after this reply…' : 'Message, ticket or image… (/ for commands)'}
          onChange={event => setText(event.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={event => {
            if (menuItems && !composing.current) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setMenuActive(i => (i + step + Math.max(menuItems.length, 1)) % Math.max(menuItems.length, 1));
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && menuItems[menuActive]) {
                event.preventDefault();
                pickCommand(menuItems[menuActive]);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setMenuClosed(text);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !composing.current) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="dictation-status" role="status" aria-live="polite">
          {recording ? (
            <>
              <strong>{dictation.phase === 'starting' ? 'Starting microphone…' : dictation.phase === 'stopping' ? 'Finishing…' : 'Listening…'}</strong>
              {dictation.interim && <span className="dictation-interim">{dictation.interim}</span>}
              <span>Tap the microphone to stop. Review the text before sending.</span>
            </>
          ) : dictation.error ? (
            <span className="dictation-error">{dictation.error}</span>
          ) : null}
        </div>
        <div className="copilotKitInputControls">
          {props.onUpload && (
            <button
              className="copilotKitInputControlButton copilotKitAttachButton"
              aria-label="Attach image"
              title="Attach image (or paste / drop one)"
              onClick={props.onUpload}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.4 11.1l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className={'copilotKitInputControlButton dictation-button' + (recording ? ' recording' : '')}
            aria-label={recording ? 'Stop voice typing' : 'Start voice typing'}
            aria-pressed={recording}
            aria-describedby="dictation-privacy"
            title="Voice typing uses your browser's speech service, which may process audio online. No API key needed."
            onClick={() => {
              if (dictation.phase === 'starting' || dictation.phase === 'stopping') voice.current?.cancel();
              else if (recording) voice.current?.stop();
              else voice.current?.start();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
            </svg>
          </button>
          <div style={{flexGrow: 1}} />
          {showStop && (
            <button
              className="copilotKitInputControlButton copilotKitStopButton"
              aria-label="Stop"
              title="Stop the reply"
              onClick={props.onStop}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            </button>
          )}
          <button
            className="copilotKitInputControlButton"
            aria-label={busy ? 'Queue message' : 'Send'}
            title={busy ? 'Queue: sent when the current reply finishes' : 'Send'}
            disabled={!canSend}
            onClick={() => void send()}
          >
            {busy ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h11M4 12h11M4 18h7M18 14v6M15 17h6" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            )}
          </button>
        </div>
        <small id="dictation-privacy" className="dictation-privacy">
          Voice typing uses your browser's speech service and may send audio to its provider. Muster does not record audio.
        </small>
      </div>
    </div>
  );
}

/** Messages waiting for the thread, at the top of the chat. Survives reloads: the queue lives on the server. */
function QueuePanel(props: {
  thread: Thread;
  running: boolean;
  act: (url: string) => Promise<void>;
}) {
  const queue = props.thread.queue ?? [];
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState('');
  if (!queue.length) return null;
  const base = '/threads/' + props.thread.id + '/queue';
  const run = async (key: string, url: string) => {
    setBusy(key);
    try {
      await props.act(url);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className={'queue-panel' + (props.thread.queueHeld ? ' held' : '')}>
      <button className="queue-summary" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="queue-count">{queue.length}</span>
        <span>
          {props.thread.queueHeld
            ? 'Queued messages are on hold after an interrupted or failed run'
            : props.running
              ? `queued · sent in order after the current reply`
              : 'queued · starting shortly'}
        </span>
        <span className="queue-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ol>
          {queue.map((item, index) => {
            const images = item.parts.filter(part => part.type === 'image').length;
            return (
              <li key={item.id}>
                <span className="queue-text" title={item.text}>
                  {item.text.replace(/\s+/g, ' ') || 'Image only'}
                  {images > 0 && <small> · {images} image{images > 1 ? 's' : ''}</small>}
                </span>
                {item.steering ? (
                  <small className="queue-steering">Sent · the agent reads it after its current step</small>
                ) : (
                  <>
                    <button
                      className="icon-button"
                      disabled={!!busy}
                      title={props.running ? 'Send now: the agent reads it after its current step' : 'Send now'}
                      aria-label="Send now"
                      onClick={() => void run(item.id + 'send', `${base}/${item.id}/send`)}
                    >
                      {busy === item.id + 'send' ? '…' : '⚡'}
                    </button>
                    <button
                      className="icon-button"
                      disabled={!!busy}
                      title="Remove from the queue"
                      aria-label="Remove from the queue"
                      onClick={() => void run(item.id + 'remove', `${base}/${item.id}/remove`)}
                    >
                      ×
                    </button>
                  </>
                )}
                {index === 0 && props.thread.queueHeld && (
                  <button className="quiet" disabled={!!busy} onClick={() => void run('release', `${base}/release`)}>
                    Resume queue
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** claude-bridge/claude-opus-5-5 → opus-5-5; the full id is in the chip's tooltip. */
const shortModel = (id: string) => (id ? id.split('/').pop()!.replace(/^claude-/, '') : 'model');
const tokensLabel = (n: number) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));

type CompactionInfo = {reserveTokens: number; source: 'default' | 'pi' | 'model' | 'folder'; enabled: boolean; defaultReserve: number};

/** Slider for where Pi auto-compacts this model, saved to Pi's settings.json. */
function AutoCompact(props: {model: string; contextWindow: number; cwd: string; onPoint: (tokens: number | null) => void}) {
  const {model, contextWindow, cwd} = props;
  const [info, setInfo] = useState<CompactionInfo | null>(null);
  const [value, setValue] = useState(0);
  const [status, setStatus] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const step = contextWindow >= 400_000 ? 10_000 : contextWindow >= 100_000 ? 5_000 : 1_000;
  const fullAt = info ? contextWindow - info.defaultReserve : contextWindow;
  const min = Math.max(step * 2, Math.ceil((contextWindow * 0.1) / step) * step);
  useEffect(() => {
    let live = true;
    api(`/compaction?model=${encodeURIComponent(model)}&cwd=${encodeURIComponent(cwd)}`)
      .then((data: CompactionInfo) => {
        if (!live) return;
        setInfo(data);
        setValue(contextWindow - data.reserveTokens);
        props.onPoint(contextWindow - data.reserveTokens);
      })
      .catch(error => live && setStatus(error.message));
    return () => {
      live = false;
      window.clearTimeout(timer.current);
    };
  }, [model, contextWindow, cwd]);
  if (!info) return status ? <small>{status}</small> : null;
  const locked = info.source === 'folder';
  const save = (next: number) => {
    window.clearTimeout(timer.current);
    setStatus('');
    timer.current = window.setTimeout(async () => {
      try {
        // At the far right the override is removed and Pi's own setting applies again.
        const data: CompactionInfo = await api('/compaction', {model, contextWindow, cwd, threshold: next >= fullAt ? null : next});
        setInfo(data);
        setStatus('Saved. Applies from the next message.');
      } catch (error: any) {
        setStatus(error.message);
      }
    }, 600);
  };
  const atDefault = value >= fullAt;
  return (
    <div className="auto-compact">
      <label htmlFor="auto-compact-range">
        <span>Auto-compact at</span>
        <strong>
          {tokensLabel(value)} ({Math.round((value / contextWindow) * 100)}%)
        </strong>
      </label>
      <input
        id="auto-compact-range"
        type="range"
        min={min}
        max={fullAt}
        step={step}
        value={Math.min(Math.max(value, min), fullAt)}
        disabled={locked}
        onChange={event => {
          const next = Number(event.target.value);
          setValue(next);
          props.onPoint(next);
          save(next);
        }}
      />
      <small>
        {locked
          ? "Set by this folder's .pi/settings.json."
          : status ||
            (atDefault
              ? `Pi's default: just before the window is full. Applies to every ${shortModel(model)} thread.`
              : `Applies to every ${shortModel(model)} thread, in Muster and in Pi.`)}
      </small>
      {!info.enabled && <small>Auto-compaction is turned off in Pi's settings.</small>}
      {!locked && !atDefault && (
        <button
          className="quiet auto-compact-reset"
          onClick={() => {
            setValue(fullAt);
            props.onPoint(fullAt);
            save(fullAt);
          }}
        >
          Reset to Pi default
        </button>
      )}
    </div>
  );
}

/** How full the model's context window is, as a ring with the percentage. */
function ContextMeter(props: {
  usage?: Thread['contextUsage'];
  cwd: string;
  model: string;
  canCompact: boolean;
  compact: () => void;
  compacting?: boolean;
}) {
  const {usage} = props;
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState<number | null>(null);
  if (!usage || !usage.contextWindow) return null;
  const known = usage.percent !== null && usage.tokens !== null;
  const percent = known ? Math.min(100, Math.max(0, usage.percent!)) : 0;
  const level = percent >= 90 ? 'full' : percent >= 70 ? 'high' : 'ok';
  const summary = known
    ? `${tokensLabel(usage.tokens!)} / ${tokensLabel(usage.contextWindow)} tokens`
    : `– / ${tokensLabel(usage.contextWindow)} tokens`;
  const circumference = 2 * Math.PI * 9;
  return (
    <div className="menu-wrap">
      <button
        className={'context-meter ' + level + (props.compacting ? ' compacting' : '')}
        title={`Context: ${summary}${known ? ` (${percent}%)` : ''}. Tap for details.`}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle cx="12" cy="12" r="9" className="track" />
          <circle
            cx="12"
            cy="12"
            r="9"
            className="fill"
            strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
            transform="rotate(-90 12 12)"
          />
        </svg>
        <span>{known ? percent + '%' : '–'}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="thread-menu context-details" role="dialog" aria-label="Context usage">
            <strong className={level}>{summary}</strong>
            <div className="context-bar">
              <span className={level} style={{width: percent + '%'}} />
              {point !== null && (
                <i className="context-mark" style={{left: Math.min(100, (point / usage.contextWindow) * 100) + '%'}} />
              )}
            </div>
            <small>
              {known
                ? `${percent}% of the context window used`
                : 'Measured after the next reply (just compacted or not run yet)'}
            </small>
            <small>
              {shortModel(props.model)} · {tokensLabel(usage.contextWindow)} window
            </small>
            <small>Updated {ago(usage.at / 1000)}</small>
            {props.model.includes('/') && (
              <AutoCompact model={props.model} contextWindow={usage.contextWindow} cwd={props.cwd} onPoint={setPoint} />
            )}
            <button
              className="menu-item"
              disabled={!props.canCompact}
              onClick={() => {
                setOpen(false);
                props.compact();
              }}
            >
              Compact now: summarise earlier turns
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO = /\.(mp3|wav|m4a|ogg|oga|flac|aac|opus)$/i;
const TEXT =
  /(\.(txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|sh|bash|zsh|py|js|mjs|cjs|ts|tsx|jsx|css|scss|sql|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|swift|diff|patch|lock|gitignore)|\/(Dockerfile|Makefile|Procfile|README|LICENSE)[^/]*)$/i;
const MAX_TEXT_PREVIEW = 2 * 1024 * 1024;

function fileKind(file: SharedFile) {
  if (IMAGE.test(file.name)) return 'image';
  if (VIDEO.test(file.name)) return 'video';
  if (AUDIO.test(file.name)) return 'audio';
  if (/\.pdf$/i.test(file.name)) return 'pdf';
  if (/\.html?$/i.test(file.name)) return 'html';
  if (/\.(md|markdown)$/i.test(file.name)) return 'markdown';
  if (TEXT.test('/' + file.name) || !file.name.includes('.')) return 'text';
  return 'other';
}
const sizeLabel = (n: number) =>
  n < 1024 ? n + ' B' : n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
const fileUrl = (thread: Thread, file: SharedFile) => `/api/threads/${thread.id}/files/${file.id}?v=${Math.round(file.mtime)}`;
/** Folder shown under a file name: relative to the thread's folder when inside it. */
function fileFolder(thread: Thread, file: SharedFile) {
  const dir = file.path.slice(0, file.path.length - file.name.length - 1);
  if (dir === thread.cwd) return './';
  return dir.startsWith(thread.cwd + '/') ? './' + dir.slice(thread.cwd.length + 1) : dir;
}

/** Finds the shared file a path in a chat message refers to: absolute, ~/, relative to the folder, or a unique name. */
function matchFile(thread: Thread, raw: string) {
  const files = thread.files ?? [];
  const text = raw.trim().replace(/^file:\/\//, '').replace(/[),.;:]+$/, '');
  if (!text || text.length > 1000 || /\s/.test(text)) return undefined;
  const exact = files.find(file => file.path === text);
  if (exact) return exact;
  const tail = text.replace(/^~\//, '/').replace(/^\.\//, '/');
  if (tail.includes('/')) return files.find(file => file.path.endsWith(tail.startsWith('/') ? tail : '/' + tail));
  const named = files.filter(file => file.name === text);
  return named.length === 1 ? named[0] : undefined;
}

function FileView({thread, file}: {thread: Thread; file: SharedFile}) {
  const url = fileUrl(thread, file);
  const kind = fileKind(file);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState('');
  const readable = (kind === 'text' || kind === 'markdown') && file.size <= MAX_TEXT_PREVIEW;
  useEffect(() => {
    if (!readable) return;
    setText(null);
    setFailed('');
    fetch(url, {credentials: 'same-origin'})
      .then(async response => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not open the file');
        setText(await response.text());
      })
      .catch(error => setFailed(error.message));
  }, [url, readable]);
  if (failed) return <p className="file-note">{failed}</p>;
  switch (kind) {
    case 'image':
      return <img className="file-image" src={url} alt={file.name} />;
    case 'video':
      return <video className="file-media" src={url} controls playsInline />;
    case 'audio':
      return <audio className="file-audio" src={url} controls />;
    case 'pdf':
      return <iframe className="file-frame" src={url} title={file.name} />;
    case 'html':
      return (
        <iframe
          className="file-frame light"
          src={url}
          title={file.name}
          sandbox="allow-scripts allow-popups allow-downloads allow-forms"
        />
      );
  }
  if (!readable) return <p className="file-note">No preview for this file. Download it or open it in a new tab.</p>;
  if (text === null) return <p className="file-note">Loading…</p>;
  return kind === 'markdown' ? (
    <div className="file-markdown">
      <Markdown content={text} />
    </div>
  ) : (
    <pre className="file-text">{text}</pre>
  );
}

/** Files the agent made or shared in this thread, with previews that work on a phone. */
/** Code the agent changed vs. outputs it produced. Files listed before sections existed are sorted by type. */
function fileSection(file: SharedFile) {
  if (file.kind) return file.kind;
  if (file.via === 'share') return 'artifact';
  return file.via === 'edit' || /\.(sh|py|rb|js|mjs|cjs|ts|tsx|jsx|css|go|rs|java|kt|swift|c|h|cpp|sql|ya?ml|toml|json)$/i.test(file.name)
    ? 'change'
    : 'artifact';
}

/** The diff of a changed file, or the file itself. Falls back to the file when no earlier version was saved. */
function ChangeView({thread, file}: {thread: Thread; file: SharedFile}) {
  const [mode, setMode] = useState<'diff' | 'file'>('diff');
  const [whole, setWhole] = useState(false);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    if (mode !== 'diff') return;
    setFailed('');
    api(`/threads/${thread.id}/files/${file.id}/diff${whole ? '?context=all' : ''}`)
      .then(setDiff)
      .catch((error: any) => setFailed(error.message));
  }, [thread.id, file.id, file.mtime, mode, whole]);
  return (
    <>
      <div className="diff-tabs" role="tablist">
        <button role="tab" aria-selected={mode === 'diff'} className={mode === 'diff' ? 'active' : ''} onClick={() => setMode('diff')}>
          Changes
        </button>
        <button role="tab" aria-selected={mode === 'file'} className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>
          File
        </button>
        {mode === 'diff' && diff && !diff.created && (
          <label className="check diff-whole">
            <input type="checkbox" checked={whole} onChange={event => setWhole(event.target.checked)} />
            Whole file
          </label>
        )}
      </div>
      {mode === 'file' ? (
        <FileView key={file.id + file.mtime} thread={thread} file={file} />
      ) : failed ? (
        <>
          <p className="file-note">{failed} Showing the file instead.</p>
          <FileView key={file.id + file.mtime} thread={thread} file={file} />
        </>
      ) : !diff ? (
        <p className="file-note">Loading…</p>
      ) : !diff.added && !diff.removed ? (
        <p className="file-note">The file is back to how it was before this thread changed it.</p>
      ) : (
        <Suspense fallback={<p className="file-note">Loading…</p>}>
          <DiffView patch={diff.patch} />
        </Suspense>
      )}
    </>
  );
}

function FileRow(props: {thread: Thread; entry: SharedFile; open: () => void; report: (e: any) => void}) {
  const {thread, entry} = props;
  // Line counts matter for code; a new report is all additions anyway.
  const counted = entry.linesAdded !== undefined && fileSection(entry) === 'change';
  return (
    <li>
      <button className="file-row" onClick={props.open}>
        <span className={'file-kind ' + fileKind(entry)}>
          {(entry.name.includes('.') ? entry.name.split('.').pop()! : 'file').slice(0, 4)}
        </span>
        <span className="file-meta">
          <strong>
            {entry.name}
            {entry.created && <em className="file-new">new</em>}
          </strong>
          <small>
            {counted && (
              <>
                <b className="plus">+{entry.linesAdded}</b> <b className="minus">−{entry.linesRemoved}</b> ·{' '}
              </>
            )}
            {fileFolder(thread, entry)} · {sizeLabel(entry.size)} · {ago(entry.mtime / 1000)}
          </small>
        </span>
      </button>
      <a
        className="icon-button"
        href={fileUrl(thread, entry) + '&download=1'}
        download={entry.name}
        title="Download"
        aria-label={'Download ' + entry.name}
      >
        ⤓
      </a>
      <button
        className="icon-button"
        title="Remove from this list (the file stays on the desktop)"
        aria-label={'Remove ' + entry.name + ' from the list'}
        onClick={() => void api(`/threads/${thread.id}/files/${entry.id}/remove`, {}).catch(props.report)}
      >
        ×
      </button>
    </li>
  );
}

function FilesPanel(props: {thread: Thread; open: string; setOpen: (id: string) => void; close: () => void; report: (e: any) => void; openSettings: () => void}) {
  const {thread} = props;
  const files = [...(thread.files ?? [])].reverse();
  const file = files.find(candidate => candidate.id === props.open);
  const changes = files.filter(entry => fileSection(entry) === 'change');
  const artifacts = files.filter(entry => fileSection(entry) === 'artifact');
  const prCount = sessionPrUrls(thread.messages).length;
  const [tab, setTab] = useState<'change' | 'artifact' | 'prs'>(() => files.length ? (changes.length ? 'change' : 'artifact') : 'prs');
  const shown = tab === 'change' ? changes : artifacts;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.close]);
  return (
    <div className="modal-backdrop" onClick={props.close}>
      <section className="preview files-panel" role="dialog" aria-modal="true" aria-label="Files" onClick={e => e.stopPropagation()}>
        <header>
          {file ? (
            <button className="quiet" onClick={() => props.setOpen('')}>
              ← Files
            </button>
          ) : (
            <span className="eyebrow">FILES · {files.length}</span>
          )}
          <button onClick={props.close} aria-label="Close files">
            ×
          </button>
        </header>
        {file ? (
          <>
            <div className="file-head">
              <div>
                <strong title={file.path}>{file.name}</strong>
                <small>
                  {fileFolder(thread, file)} · {sizeLabel(file.size)} · {ago(file.mtime / 1000)}
                </small>
              </div>
              <a className="button-link" href={fileUrl(thread, file)} target="_blank" rel="noopener">
                Open
              </a>
              <a className="button-link" href={fileUrl(thread, file) + '&download=1'} download={file.name}>
                Download
              </a>
            </div>
            {/* Only this part scrolls, so the header and the way back stay in reach on a phone. */}
            <div className="files-body">
              {fileSection(file) === 'change' ? (
                <ChangeView key={file.id} thread={thread} file={file} />
              ) : (
                <FileView key={file.id + file.mtime} thread={thread} file={file} />
              )}
            </div>
          </>
        ) : files.length || prCount ? (
          <>
            <div className="files-tabs" role="tablist">
              {(
                [
                  ['change', 'Code changes', changes.length],
                  ['artifact', 'Artifacts', artifacts.length],
                  ['prs', 'Pull requests', prCount],
                ] as const
              ).map(([id, title, count]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                  {title} <span>{count}</span>
                </button>
              ))}
            </div>
            <div className="files-body">
              {tab === 'prs' ? (
                <Suspense fallback={<p className="file-note">Loading…</p>}>
                  <PullRequestsPanel threadId={thread.id} api={api} openSettings={props.openSettings} />
                </Suspense>
              ) : shown.length ? (
                <ul className="file-list">
                  {shown.map(entry => (
                    <FileRow key={entry.id} thread={thread} entry={entry} open={() => props.setOpen(entry.id)} report={props.report} />
                  ))}
                </ul>
              ) : (
                <p className="file-note">
                  {tab === 'change'
                    ? 'No code changes in this thread yet.'
                    : 'No artifacts yet. Ask the agent to share a file, for example a report it generated with a script.'}
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="file-note">
            Files the agent writes in this thread show up here. Ask it to share any other file, for example a report it
            generated with a script.
          </p>
        )}
      </section>
    </div>
  );
}

/** Full-screen view of an image from the chat. Tap anywhere or press Escape to close. */
function Lightbox({src, close}: {src: string; close: () => void}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className="lightbox" role="dialog" aria-label="Image" onClick={close}>
      <img src={src} alt="" />
      <button className="lightbox-close" aria-label="Close image" onClick={close}>
        ×
      </button>
    </div>
  );
}

/** Paste, drop or attach images in the chat. The server checks each file's signature too. */
const IMAGE_ATTACHMENTS = {enabled: true, accept: 'image/png,image/jpeg,image/gif,image/webp', maxSize: 10 * 1024 * 1024};
const CONTINUE_UNAVAILABLE = 'Only Pi sessions can be continued in place. Split brings this conversation into Pi.';
const ACTIONS: {key: FinderMatch['action']; label: string; help: string}[] = [
  {key: 'continue', label: 'Continue', help: 'Keep working inside this Pi session. New messages are added to the original file.'},
  {key: 'split', label: 'Split', help: 'Branch a copy and work there. The original session stays as it is.'},
  {key: 'new', label: 'New with context', help: 'Start a fresh thread that receives cited excerpts from this session.'},
];

/** The start screen: describe the work, let the LLM find earlier sessions, then pick how to resume. */
function FinderPanel(props: {
  model: string;
  thinking: string;
  cwd: string;
  setCwd: (value: string) => void;
  selected: string[];
  clearSelected: () => void;
  inspect: (id: string) => void;
  report: (error: any) => void;
  open: (thread: Thread, prefill?: string) => void;
  /** Opened with the + button: start empty and ready to type. */
  fresh?: boolean;
}) {
  const [query, setQuery] = useState(() => sessionStorage.getItem('muster.finderQuery') || '');
  const [finder, setFinder] = useState<FinderState | null>(null);
  const [busy, setBusy] = useState('');
  const finderId = useRef(sessionStorage.getItem('muster.finderId') || '');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.fresh) box.current?.focus();
  }, []);

  // Polls the running search; a reload picks the latest search back up.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (!finderId.current || stopped) return;
      try {
        const next = await api('/finder/' + finderId.current);
        if (stopped) return;
        setFinder(next);
        if (next.status === 'running') setTimeout(() => void poll(), 900);
      } catch {
        finderId.current = '';
        sessionStorage.removeItem('muster.finderId');
        setFinder(null);
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [finder?.id]);

  const find = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = query.trim();
    if (!text) return;
    try {
      sessionStorage.setItem('muster.finderQuery', text);
      const started = await api('/finder', {query: text, model: props.model || undefined});
      finderId.current = started.id;
      sessionStorage.setItem('muster.finderId', started.id);
      setFinder(started);
    } catch (e) {
      props.report(e);
    }
  };

  const act = async (match: FinderMatch, action: FinderMatch['action']) => {
    const risky = action === 'continue' && match.recentlyActive;
    if (risky && !confirm('This session changed in the last few minutes and may be open in another Pi. Continue anyway?')) {
      return;
    }
    setBusy(match.id + action);
    try {
      const created = await api('/threads/from-session', {sessionId: match.id, action, cwd: props.cwd});
      props.open(created, finder?.query || query);
    } catch (e) {
      props.report(e);
    } finally {
      setBusy('');
    }
  };

  // Starts a thread and, when something is typed, sends it straight away as the first message.
  const [starting, setStarting] = useState(false);
  const startBlank = async () => {
    const text = query.trim();
    setStarting(true);
    try {
      const created = await api('/threads', {
        cwd: props.cwd,
        sources: props.selected,
        automatic: props.selected.length > 0,
      });
      if (text) {
        await api(`/threads/${created.id}/queue`, {text, model: props.model || undefined, thinking: props.thinking || undefined});
        sessionStorage.removeItem('muster.finderQuery');
        sessionStorage.removeItem('muster.finderId');
      }
      props.clearSelected();
      props.open(created);
    } catch (e) {
      props.report(e);
    } finally {
      setStarting(false);
    }
  };

  const running = finder?.status === 'running';
  return (
    <div className="finder">
      <h1>What are you working on?</h1>
      <p className="muted">
        Describe the task, project or ticket. Pi reads your Pi, Claude Code and Codex history, picks the sessions that
        matter, and you choose to continue, split or start fresh.
      </p>
      <form onSubmit={event => void find(event)}>
        <textarea
          ref={box}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void find();
          }}
          rows={3}
          placeholder="e.g. what last happened on the myteammate project, or PROJ-1482 login redirect"
        />
        <div className="finder-buttons">
          <button className="primary" disabled={!query.trim() || running}>
            {running ? 'Searching…' : 'Find sessions'}
          </button>
          <button
            type="button"
            className={query.trim() ? 'start-now' : 'quiet'}
            disabled={starting}
            title="Start a fresh session and send this message, without searching earlier sessions"
            onClick={() => void startBlank()}
          >
            {starting
              ? 'Starting…'
              : props.selected.length
                ? `Start with ${props.selected.length} selected sources`
                : query.trim()
                  ? 'Start now'
                  : 'Start without history'}
          </button>
        </div>
      </form>

      {finder && (
        <section className="finder-result" aria-live="polite">
          {running && (
            <div className="finder-progress">
              <i className="dot busy" />
              <div>
                {finder.steps.slice(-5).map((s, i, list) => (
                  <p key={s.at + s.text} className={i === list.length - 1 ? 'current' : ''}>
                    {s.text}
                  </p>
                ))}
              </div>
              <button
                className="quiet"
                onClick={() =>
                  void api('/finder/' + finder.id + '/cancel', {}).then(() => setFinder({...finder, status: 'failed', error: 'Cancelled'}))
                }
              >
                Cancel
              </button>
            </div>
          )}
          {finder.status === 'failed' && (
            <p className="run-error">
              {finder.error}{' '}
              <button className="quiet" onClick={() => void find()}>
                Try again
              </button>
            </p>
          )}
          {finder.status === 'done' && (
            <>
              {finder.summary && (
                <div className="finder-summary">
                  <Markdown content={finder.summary} />
                </div>
              )}
              {(finder.matches ?? []).map(match => (
                <article key={match.id} className="match">
                  <div className="card-meta">
                    <span className={'provider ' + match.engine}>{providerName(match.engine)}</span>
                    <span>
                      {date(match.modified)} · {match.cwd.split('/').slice(-2).join('/') || 'no directory'}
                    </span>
                  </div>
                  <h3>{match.title}</h3>
                  <p className="why">{match.why}</p>
                  <p className="state">
                    <strong>Left off:</strong> {match.state}
                  </p>
                  {match.recentlyActive && match.canContinue && (
                    <p className="warn">Changed in the last few minutes. It may be open in another Pi, so Split is safer.</p>
                  )}
                  <div className="match-actions">
                    {ACTIONS.map(({key, label, help}) => {
                      const disabled = key === 'continue' && !match.canContinue;
                      return (
                        <button
                          key={key}
                          className={match.action === key ? 'primary' : ''}
                          disabled={disabled || !!busy}
                          title={disabled ? CONTINUE_UNAVAILABLE : help}
                          onClick={() => void act(match, key)}
                        >
                          {busy === match.id + key ? 'Opening…' : label}
                          {match.action === key && <span className="recommended">Recommended</span>}
                        </button>
                      );
                    })}
                    <button className="quiet" onClick={() => props.inspect(match.id)}>
                      Preview
                    </button>
                  </div>
                </article>
              ))}
              <small className="muted">
                Session excerpts are sent to your model provider to rank them. The index itself stays on this desktop.
              </small>
            </>
          )}
        </section>
      )}

      <details className="finder-options">
        <summary>Options</summary>
        <label htmlFor="cwd">Working directory for new and Claude/Codex threads</label>
        <input id="cwd" value={props.cwd} onChange={e => props.setCwd(e.target.value)} spellCheck={false} />
        <small className="muted">Continue and Split use the earlier session's directory when it is inside your workspace.</small>
      </details>
    </div>
  );
}

const ago = (seconds: number) => {
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};
const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
const providerName = (engine: string) => (engine === 'claude' ? 'Claude Code' : engine === 'codex' ? 'Codex' : 'Pi');
const ACTIVE = ['running', 'preparing', 'paused'];

function Login({done}: {done: () => void}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/login', {password});
      setPassword('');
      done();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <div className="login-card">
        <img className="mark" src="/icons/icon-192.png" alt="" />
        <span className="eyebrow">ALL YOUR AGENTS, ONE PLACE</span>
        <h1>Muster</h1>
        <p>
          Search earlier work. Start the next thread.
          <br />
          Take over BrowserOS when it needs you.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="password">Owner password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            required
          />
          <button className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <small>
          The initial password is saved on your desktop in <code>initial-password.txt</code> in Muster's data folder
          (<code>~/.local/share/muster</code> unless you set <code>MUSTER_DATA_DIR</code>). Muster prints the path when it
          starts.
        </small>
      </div>
    </main>
  );
}

type SessionAction = 'continue' | 'split' | 'new';

/** Continue, Split and New for an earlier session, the same choices the finder offers. */
function SessionActions(props: {source: Source; open: (action: SessionAction) => void; compact?: boolean}) {
  const canContinue = props.source.engine === 'pi' && !props.source.sidechain;
  return (
    <span className={'session-actions' + (props.compact ? ' compact' : '')}>
      <button
        className="quiet"
        disabled={!canContinue}
        title={canContinue ? ACTIONS[0].help : CONTINUE_UNAVAILABLE}
        onClick={() => props.open('continue')}
      >
        Continue
      </button>
      <button className="quiet" title={ACTIONS[1].help} onClick={() => props.open('split')}>
        Split
      </button>
      <button className="quiet" title={ACTIONS[2].help} onClick={() => props.open('new')}>
        New
      </button>
    </span>
  );
}

function SourceCard(props: {
  source: Source;
  selected: boolean;
  inspect: () => void;
  toggle: () => void;
  open: (action: SessionAction) => void;
}) {
  const {source, selected} = props;
  return (
    <article className={'source-card ' + (selected ? 'selected' : '')}>
      <div className="card-meta">
        <span className={'provider ' + source.engine}>{providerName(source.engine)}</span>
        <span>
          {source.ticket ? 'Ticket match · ' : ''}
          {date(source.modified)}
          {source.sidechain ? ' · subagent' : ''}
        </span>
      </div>
      <button className="source-title" onClick={props.inspect}>
        {source.title}
      </button>
      <small className="path" title={source.cwd}>
        {source.cwd || 'No working directory'}
      </small>
      <div className="card-actions">
        <button className="quiet" onClick={props.inspect}>
          Preview
        </button>
        <SessionActions source={source} open={props.open} compact />
        {selected && (
          <button className="quiet" onClick={props.toggle} title="Remove from the sources for the next new thread">
            ✓ Selected
          </button>
        )}
      </div>
    </article>
  );
}

function Preview(props: {source: Source; close: () => void; use: () => void; open: (action: SessionAction) => void}) {
  const {source} = props;
  return (
    <div className="modal-backdrop" onClick={props.close}>
      <section
        className="preview"
        role="dialog"
        aria-modal="true"
        aria-label="Source preview"
        onClick={e => e.stopPropagation()}
      >
        <header>
          <span className="eyebrow">{source.engine} · READ-ONLY SOURCE</span>
          <button onClick={props.close} aria-label="Close preview">
            ×
          </button>
        </header>
        <h2>{source.title}</h2>
        <code className="source-path">{source.path}</code>
        <div className="preview-actions">
          <SessionActions source={source} open={props.open} />
        </div>
        <p className="muted">Recent indexed excerpts. Branch references are preserved; older conclusions may be stale.</p>
        {source.chunks?.map((chunk, i) => (
          <article className="excerpt" key={i}>
            <small>
              {chunk.role} · line {chunk.line}
              {chunk.branch ? ' · branch ' + chunk.branch.slice(0, 10) : ''}
            </small>
            <pre>{chunk.text}</pre>
          </article>
        ))}
        <div className="preview-actions">
          <SessionActions source={source} open={props.open} />
          <button className="quiet" onClick={props.use}>
            + Add as context for a new thread
          </button>
        </div>
      </section>
    </div>
  );
}

function BrowserPanel(props: {hide: () => void; release: () => void}) {
  return (
    <section className="browser-panel" role="dialog" aria-modal="true" aria-label="Remote BrowserOS">
      <header>
        <div>
          <strong>BrowserOS · your desktop session</strong>
          <small>Credentials bypass chat. External agents are not paused by this app.</small>
        </div>
        <button onClick={props.hide}>Hide viewer</button>
        <button className="primary" onClick={props.release}>
          Return control to agent
        </button>
      </header>
      <iframe title="Live BrowserOS remote view" src="/viewer" sandbox="allow-scripts allow-same-origin" />
      <footer>
        Page view only. Native OS dialogs, Touch ID and hardware security keys may require another sign-in method or
        physical access.
      </footer>
    </section>
  );
}

/** The Muster icon with a spinning ring, for anything that is loading. Matches the splash in index.html. */
function LoadingMark({label}: {label: string}) {
  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="boot-mark">
        <img src="/icons/icon-192.png" alt="" />
      </div>
      <span>{label}</span>
    </div>
  );
}

/**
 * Covers the chat with the loading mark until a thread's saved messages arrive, instead of an empty chat.
 * Gives up after 15 seconds so a slow or failed load still leaves the chat usable.
 */
function ChatLoading({expected}: {expected: boolean}) {
  const [done, setDone] = useState(!expected);
  useEffect(() => {
    if (done) return;
    // Watches the rendered chat, which works whatever CopilotKit's hooks expose in this version.
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (document.querySelector('.copilotKitMessages .copilotKitMessage') || Date.now() - started > 15_000) setDone(true);
    }, 80);
    return () => window.clearInterval(timer);
  }, [done]);
  if (done) return null;
  return (
    <div className="chat-loading">
      <LoadingMark label="Loading messages…" />
    </div>
  );
}

/** The open thread lives in the URL, so a reload, the back button or a saved link reopens it. */
const threadInUrl = () => new URLSearchParams(location.search).get('thread') || '';
function urlWith(changes: Record<string, string>) {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return location.pathname + (query ? '?' + query : '');
}

function App() {
  const [signed, setSigned] = useState<boolean | undefined>();
  const [status, setStatus] = useState<any>();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  // Slash commands for the open thread's folder; the server caches them, so switching threads is cheap.
  const [commands, setCommands] = useState<SlashCommand[] | undefined>(undefined);
  useEffect(() => {
    setCommands(undefined);
    if (!thread?.id) return;
    let live = true;
    api(`/threads/${thread.id}/commands`)
      .then(data => live && setCommands(data.commands))
      .catch(() => live && setCommands([]));
    return () => {
      live = false;
    };
  }, [thread?.id]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Source[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Source | null>(null);
  const [cwd, setCwd] = usePref('workingDirectory', '');
  const [automatic, setAutomatic] = usePref('findSessions', true);
  const [showThinking, setShowThinking] = usePref('showThinking', false);
  const [showTools, setShowTools] = usePref('showToolCalls', false);
  const [menu, setMenu] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [appMenu, setAppMenu] = useState(false);
  // Modules: integrations with actions such as deploys (Settings → Modules, the ⚡ Actions panel).
  const [moduleList, setModuleList] = useState<ModuleInfo[]>([]);
  const [panel, setPanel] = useState<'' | 'actions' | 'modules' | 'terminal'>('');
  // A module to open straight to in Module settings; the menu opens the picker.
  const [moduleFocus, setModuleFocus] = useState('');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [notify, setNotify] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted');
  const [prefill, setPrefill] = useState('');
  const [lightbox, setLightbox] = useState('');
  // null: Files panel closed; '' : the list; an id: that file's preview.
  const [filesOpen, setFilesOpen] = useState<string | null>(null);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const openId = useRef('');

  // Any image in the chat, thinking or the queue of images to send opens full screen.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName !== 'IMG') return;
      if (!target.closest('.copilotKitMessage, .thinking, .copilotKitAttachmentQueue, .finder-summary, .tool-images')) return;
      event.preventDefault();
      event.stopPropagation();
      setLightbox((target as HTMLImageElement).currentSrc || (target as HTMLImageElement).src);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  // Table cells stay on one line so rows are compact; cells with long text are marked so they can wrap.
  useEffect(() => {
    const mark = () => {
      // Rechecked on every change: a streamed cell can start short and grow.
      document.querySelectorAll<HTMLTableCellElement>('.copilotKitMessage td, .thinking-body td, .file-markdown td').forEach(cell => {
        const long = (cell.textContent ?? '').trim().length > 48;
        if (cell.classList.contains('long-cell') !== long) cell.classList.toggle('long-cell', long);
      });
    };
    let pending = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(mark);
    });
    observer.observe(document.body, {childList: true, subtree: true, characterData: true});
    mark();
    return () => observer.disconnect();
  }, []);
  // Paths of shared files in chat messages open the file. Marked as links once the file is listed.
  const openThread_ = useRef<Thread | null>(null);
  useEffect(() => {
    const mark = () => {
      const open = openThread_.current;
      if (!open?.files?.length) return;
      document.querySelectorAll<HTMLElement>('.copilotKitMessage code, .copilotKitMessage a').forEach(element => {
        if (element.closest('pre')) return;
        const target = element.tagName === 'A' ? element.getAttribute('href') || '' : element.textContent || '';
        const file = matchFile(open, target);
        if (file) {
          element.classList.add('file-link');
          element.dataset.file = file.id;
        }
      });
    };
    const onClick = (event: MouseEvent) => {
      const link = (event.target as HTMLElement).closest<HTMLElement>('.file-link[data-file]');
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      setFilesOpen(link.dataset.file!);
    };
    let pending = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(mark);
    });
    observer.observe(document.body, {childList: true, subtree: true, characterData: true});
    document.addEventListener('click', onClick, true);
    const interval = setInterval(mark, 2000);
    return () => {
      observer.disconnect();
      document.removeEventListener('click', onClick, true);
      clearInterval(interval);
    };
  }, []);
  // Set while a compaction started from the header runs, so the chat reloads to show its note.
  const compacting = useRef('');
  const steered = useRef(false);
  // Bumping this remounts the chat, which reconnects and reloads the thread's latest messages.
  const [chatVersion, setChatVersion] = useState(0);
  const [model, setModel] = usePref('model', '');
  const [thinking, setThinking] = usePref('thinking', '');
  const [models, setModels] = useState<ModelList | null>(null);
  // A stable object, so CopilotKit sees new properties only when the choice changes.
  const runProperties = useMemo(() => ({model, thinking}), [model, thinking]);
  const [showContext, setShowContext] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'history' | 'threads' | 'inbox'>('threads');
  // Inbox from module feeds such as Teams; checked on the server, fetched here every 30 seconds.
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const loadInbox = () => api('/inbox').then(data => setInbox(fillInbox(data))).catch(() => {});
  const [mobile, setMobile] = useState(false);
  const [activity, setActivity] = useState('');
  const [searching, setSearching] = useState(false);
  const current = useRef<Thread | null>(null);
  current.current = thread;
  openThread_.current = thread;
  // A different thread closes the Files panel.
  if (openId.current !== (thread?.id ?? '')) {
    openId.current = thread?.id ?? '';
    if (filesOpen !== null) setFilesOpen(null);
  }

  // Open the thread named in the URL once signed in, and again when the back or forward button changes it.
  const restoring = useRef(!!threadInUrl());
  // While a thread named in the URL loads, show a loading mark rather than flashing the start screen.
  const [loadingThread, setLoadingThread] = useState(() => !!threadInUrl());
  useEffect(() => {
    if (!signed) return;
    const open = async () => {
      const id = threadInUrl();
      try {
        if (id === (current.current?.id ?? '')) return;
        if (!id) {
          setThread(null);
          return;
        }
        setLoadingThread(true);
        setThread(await api('/threads/' + id));
        setTab('threads');
      } catch {
        // Deleted or unknown thread: fall back to the start screen.
        history.replaceState(null, '', urlWith({thread: ''}));
      } finally {
        restoring.current = false;
        setLoadingThread(false);
      }
    };
    void open();
    window.addEventListener('popstate', open);
    return () => window.removeEventListener('popstate', open);
  }, [signed]);
  useEffect(() => {
    if (restoring.current) return;
    const id = thread?.id ?? '';
    if (threadInUrl() !== id) history.pushState(null, '', urlWith({thread: id}));
  }, [thread?.id]);

  const refresh = async () => {
    try {
      const nextStatus = await api('/status');
      setSigned(true);
      setStatus(nextStatus);
      setCwd(value => value || nextStatus.defaultCwd);
      setThreads(await api('/threads'));
      if (current.current) setThread(await api('/threads/' + current.current.id));
    } catch (e: any) {
      if (signed) setError(e.message);
    }
  };

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const chatBusy = useRef(false);
  // CopilotChat calls this after every render, not only when the run state changes. Refreshing on
  // every call re-rendered the chat and looped, so refresh only when a run actually finishes.
  // The open thread, while this page is on screen, counts as seen; its reply is not "unread".
  const viewing = (id: string) => current.current?.id === id && document.visibilityState === 'visible';
  const openAttention = threads.find(t => t.id === thread?.id)?.attention;
  useEffect(() => {
    if (!thread || !openAttention || openAttention.kind === 'help' || openAttention.kind === 'queue') return;
    if (document.visibilityState !== 'visible') return;
    void api('/threads/' + thread.id + '/seen', {}).catch(() => {});
    setThreads(list => list.map(t => (t.id === thread.id ? {...t, attention: undefined} : t)));
  }, [thread?.id, openAttention?.at]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setThreads(list => [...list]);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // A thread that starts waiting on you while you look elsewhere raises a notice, and a system
  // notification if they are switched on. The first list load only records what is already waiting.
  const lastAttention = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const previous = lastAttention.current;
    const next = new Map<string, number>();
    for (const t of threads) if (t.attention) next.set(t.id, t.attention.at);
    lastAttention.current = next;
    if (!previous) return;
    for (const t of threads) {
      const attention = t.attention;
      if (!attention || previous.get(t.id) === attention.at || viewing(t.id)) continue;
      setNotices(list => [{id: t.id + attention.at, thread: t.id, title: t.title, attention}, ...list.filter(n => n.thread !== t.id)].slice(0, 3));
      if (notify && document.visibilityState !== 'visible' && typeof Notification !== 'undefined') {
        const shown = new Notification(t.title.slice(0, 80), {body: attention.label, tag: t.id});
        shown.onclick = () => {
          window.focus();
          void openById(t.id);
          shown.close();
        };
      }
    }
    setNotices(list => list.filter(n => next.get(n.thread) === n.attention.at));
  }, [threads]);

  useEffect(() => {
    if (!signed) return;
    void loadInbox();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadInbox();
    }, 30_000);
    const onVisible = () => document.visibilityState === 'visible' && void loadInbox();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [signed]);
  // While a check or the grouping runs, look again soon for its results.
  useEffect(() => {
    if (!inbox?.feeds.some(feed => feed.running) && !inbox?.triage.running && !inbox?.pending) return;
    const timer = window.setTimeout(() => void loadInbox(), 3000);
    return () => window.clearTimeout(timer);
  }, [inbox]);
  const markRequest = (id: string, change: {status?: 'open' | 'done'}) =>
    void api('/inbox/requests/' + id, change).then(data => setInbox(fillInbox(data))).catch(report);
  /** Starts a session from a request, with the ask and its messages ready in the box for the owner's instruction. */
  const startFromInbox = async (request: InboxRequest, messages: InboxItem[]) => {
    try {
      const created = await api('/threads', {cwd, sources: [], automatic: false});
      setInbox(fillInbox(await api('/inbox/requests/' + request.id, {thread: created.id})));
      openThread(created, requestPrefill(request, messages));
    } catch (e) {
      report(e);
    }
  };
  const inboxUnread = newRequests(inbox);

  const waiting = threads.filter(t => t.attention && !viewing(t.id)).length;
  useEffect(() => {
    document.title = (waiting ? `(${waiting}) ` : '') + 'Muster';
  }, [waiting]);

  // The thread being opened from the list or a notice; the workspace shows a loading mark until it arrives.
  const [opening, setOpening] = useState('');
  const openingRef = useRef('');
  const openById = async (id: string) => {
    if (id === current.current?.id && !openingRef.current) {
      setMobile(false);
      return;
    }
    openingRef.current = id;
    setOpening(id);
    setMobile(false);
    try {
      const next = await api('/threads/' + id);
      // A later tap on another thread wins.
      if (openingRef.current !== id) return;
      setThread(next);
      setTab('threads');
    } catch (e) {
      if (openingRef.current === id) report(e);
    } finally {
      if (openingRef.current === id) {
        openingRef.current = '';
        setOpening('');
      }
    }
  };

  useEffect(() => {
    if (!signed) return;
    void api('/modules')
      .then(data => setModuleList(data.modules))
      .catch(() => {});
  }, [signed]);

  // Ctrl+` opens or hides the terminal, as in code editors.
  useEffect(() => {
    if (!signed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === '`') {
        event.preventDefault();
        setPanel(open => (open === 'terminal' ? '' : 'terminal'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [signed]);

  const toggleNotify = async () => {
    setAppMenu(false);
    if (typeof Notification === 'undefined') {
      setError('This browser cannot show notifications. On iPhone, add Muster to the Home Screen first.');
      return;
    }
    if (notify) {
      setNotify(false);
      return;
    }
    const permission = await Notification.requestPermission();
    setNotify(permission === 'granted');
    if (permission !== 'granted') setError('Notifications are blocked for this site in your browser settings.');
  };

  const onChatProgress = useCallback((busy: boolean) => {
    if (chatBusy.current && !busy) void refreshRef.current();
    chatBusy.current = busy;
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    const signedOut = () => setSigned(false);
    window.addEventListener('signed-out', signedOut);
    return () => {
      clearInterval(timer);
      window.removeEventListener('signed-out', signedOut);
    };
  }, []);

  useEffect(() => {
    if (!signed) return;
    const timer = setTimeout(() => {
      setSearching(true);
      api('/search?q=' + encodeURIComponent(search))
        .then(found => {
          setResults(found.results);
          setWarnings(found.warnings || []);
        })
        .catch(e => setError(e.message))
        .finally(() => setSearching(false));
    }, 450);
    return () => clearTimeout(timer);
  }, [search, signed]);

  // The model list feeds the header chip, so load it once after signing in.
  useEffect(() => {
    if (!signed || models) return;
    api('/models')
      .then(setModels)
      .catch(e => setError(e.message));
  }, [signed]);

  // One stream per open thread. It follows every run on the thread, including runs started later.
  useEffect(() => {
    setMenu(false);
    setShowContext(false);
    setBackgroundOpen(false);
    if (!thread) return;
    setActivity('');
    const stream = new EventSource('/api/threads/' + thread.id + '/events');
    stream.onmessage = message => {
      const event = JSON.parse(message.data);
      if (event.type === 'snapshot') setActivity(event.output || '');
      if (event.type === 'FILES') setThread(open => (open ? {...open, files: event.files} : open));
      if (event.type === 'QUESTION') {
        setThread(open => (open ? {...open, question: event.question ?? undefined} : open));
        void refresh();
      }
      if (event.type === 'BACKGROUND') {
        setThread(open => (open ? {...open, background: event.background} : open));
        void refresh();
      }
      if (event.type === 'QUEUE') {
        setThread(open => (open ? {...open, queue: event.queue, queueHeld: event.held} : open));
        // The chat showed a message that the server queued instead; reload to show the real state.
        if (event.fallback) reloadRef.current();
        if (event.steered) steered.current = true;
        if (event.error) setError(event.error);
      }
      // The server started a queued message; reconnect the chat so it streams that reply.
      if (event.type === 'SERVER_RUN') reloadRef.current();
      if (event.type === 'RUN_STARTED') {
        setActivity('');
        void refresh();
      }
      if (event.type === 'TEXT_MESSAGE_CONTENT') setActivity(text => (text + event.delta).slice(-50_000));
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
        // A steered message is saved in the thread but was never part of the chat's own stream.
        if (steered.current) {
          steered.current = false;
          reloadRef.current();
        } else if (compacting.current === current.current?.id) {
          compacting.current = '';
          reloadRef.current();
        } else {
          void refresh();
        }
      }
    };
    return () => stream.close();
  }, [thread?.id]);

  const report = (e: any) => setError(e.message);
  const compact = async () => {
    if (!thread) return;
    try {
      compacting.current = thread.id;
      await api('/threads/' + thread.id + '/context', {model: model || undefined});
      void refresh();
    } catch (e) {
      compacting.current = '';
      report(e);
    }
  };

  // Threads opened from an earlier session have no measurement yet; take one quietly.
  const measured = useRef(new Set<string>());
  // A context measurement is quiet and gives way to a new message, so it does not count as busy.
  const threadBusy = !!thread?.run && ACTIVE.includes(thread.run.status) && thread.run.task !== 'stats';
  const queueing = useMemo(
    () => ({
      busy: threadBusy || !!status?.takeover,
      retry: async () => {
        if (!thread) return;
        const ok = confirm(
          'Retry your last message?\n\nThe agent starts again from just before it, without this reply. ' +
            'Commands it ran and files it changed are not undone.',
        );
        if (!ok) return;
        try {
          await api('/threads/' + thread.id + '/retry', {model: model || undefined, thinking: thinking || undefined});
        } catch (e) {
          report(e);
        }
      },
      enqueue: async (text: string, images: any[]) => {
        if (!thread) return;
        try {
          const body = {text, images, model: model || undefined, thinking: thinking || undefined};
          const added = await api('/threads/' + thread.id + '/queue', body);
          // The queue event may have arrived first.
          setThread(open =>
            open && open.id === thread.id && !open.queue?.some(item => item.id === added.id)
              ? {...open, queue: [...(open.queue ?? []), added]}
              : open,
          );
        } catch (e) {
          report(e);
          throw e;
        }
      },
    }),
    [thread?.id, threadBusy, status?.takeover, model, thinking],
  );
  const prCount = thread ? sessionPrUrls(thread.messages).length : 0;
  const chipModel = model || models?.defaults.model || 'Pi default';
  const chipTitle = `Model: ${chipModel} · thinking ${thinking || models?.defaults.thinking || 'default'}. Click to change.`;
  useEffect(() => {
    if (!thread || thread.contextUsage || threadBusy || measured.current.has(thread.id)) return;
    if (!thread.messages.length) return;
    measured.current.add(thread.id);
    void api('/threads/' + thread.id + '/context?measure=1', {model: model || undefined}).catch(() => {});
  }, [thread?.id, threadBusy]);

  /** Opens a history session as a thread: continue it in place, split a copy, or start new with its context. */
  const openFromSession = async (source: Source, action: SessionAction) => {
    const recent = Date.now() / 1000 - source.modified < 300;
    if (action === 'continue' && recent &&
        !confirm('This session changed in the last few minutes and may be open in another Pi. Continue anyway?')) {
      return;
    }
    try {
      const created = await api('/threads/from-session', {sessionId: source.id, action, cwd});
      setPreview(null);
      openThread(created);
    } catch (e) {
      report(e);
    }
  };

  /** Full reload: the server forgets cached model lists and the page loads the newest build. */
  const reloadApp = async () => {
    setAppMenu(false);
    try {
      await api('/reload', {});
    } catch {
      // Reload the page regardless; a stale model list refreshes within ten minutes.
    }
    // A fresh URL makes mobile browsers fetch the page instead of reusing a cached copy.
    location.replace(urlWith({r: String(Date.now())}));
  };

  /** Reloads the open chat from the server, keeping any draft in the message box. */
  const reloadChat = () => {
    const draft = document.querySelector<HTMLTextAreaElement>('.copilotKitInput textarea')?.value ?? '';
    if (draft) setPrefill(draft);
    setChatVersion(version => version + 1);
    void refresh();
  };
  const reloadRef = useRef(reloadChat);
  reloadRef.current = reloadChat;

  // Mobile browsers pause background tabs, so a chat can miss messages while the app is switched away.
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (hiddenAt && Date.now() - hiddenAt > 3000 && current.current) {
        reloadRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // The + button: back to an empty start screen, from anywhere.
  const [freshStart, setFreshStart] = useState(0);
  const newSession = () => {
    openingRef.current = '';
    setOpening('');
    sessionStorage.removeItem('muster.finderQuery');
    sessionStorage.removeItem('muster.finderId');
    setSelected([]);
    setThread(null);
    setActivity('');
    setMobile(false);
    setPanel('');
    setFreshStart(value => value + 1);
  };

  /** Opens a thread and puts the finder's request in the chat box, ready to send. */
  const openThread = (created: Thread, prefill = '') => {
    setPrefill(prefill);
    setThread(created);
    setMobile(false);
    setTab('threads');
    void refresh();
  };
  const inspect = (id: string) => api('/sources/' + id).then(setPreview).catch(report);
  const toggleSource = (id: string) =>
    setSelected(list => (list.includes(id) ? list.filter(x => x !== id) : [...list.slice(-5), id]));
  const takeControl = async () => {
    try {
      await api('/browser/takeover', {});
      setBrowser(true);
      void refresh();
    } catch (e) {
      report(e);
    }
  };
  const release = async () => {
    try {
      setBrowser(false);
      await api('/browser/release', {});
      void refresh();
    } catch (e) {
      report(e);
    }
  };
  const signOut = async () => {
    // Signed in through Cloudflare Access: end that session, or the next page load signs straight back in.
    if (status?.signIn?.method === 'access') {
      location.href = '/cdn-cgi/access/logout';
      return;
    }
    await api('/logout', {});
    setSigned(false);
    setBrowser(false);
  };
  const reindex = () =>
    api('/index', {})
      .then(() => refresh())
      .catch(report);

  if (signed === undefined) {
    return (
      <main className="loading">
        <LoadingMark label="Connecting to your desktop…" />
      </main>
    );
  }
  if (!signed) return <Login done={() => void refresh()} />;

  const running = threadBusy;
  const compactingNow = running && thread?.run?.task === 'compact';
  const index = status?.index;
  const indexLabel = index?.running
    ? `${index.phase} · ${index.processed}/${index.total}`
    : index?.phase === 'failed' || index?.phase === 'interrupted'
      ? `Index ${index.phase}: ${index.error || 'refresh to retry'}`
      : `${index?.sessions || 0} sessions · updated ${index?.finished ? ago(index.finished) : 'never'}`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="mobile-toggle"
          onClick={() => setMobile(!mobile)}
          aria-label={waiting ? `Toggle sessions, ${waiting} waiting for you` : 'Toggle sessions'}
        >
          ☰{waiting + inboxUnread > 0 && <i className="attention-badge">{waiting + inboxUnread}</i>}
        </button>
        <a className="brand" href="/">
          <img className="mark small" src="/icons/icon-192.png" alt="" />
          <strong>Muster</strong>
        </a>
        <span className="connection">
          <i className={status?.browser ? 'dot' : 'dot warn'} />
          Desktop connected
        </span>
        <div className="top-actions">
          <button className="icon-button new-button" onClick={newSession} aria-label="New session" title="New session">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            className="icon-button terminal-button"
            onClick={() => setPanel(open => (open === 'terminal' ? '' : 'terminal'))}
            aria-label="Terminal"
            title="Terminal on the desktop (Ctrl+`)"
          >
            <span aria-hidden="true">&gt;_</span>
          </button>
          <button className="icon-button" onClick={() => setPanel('actions')} aria-label="Actions" title="Actions: terminal and module actions, such as deploys">
            <span aria-hidden="true">⚡</span>
          </button>
          <button
            className={'icon-button browser-button' + (status?.takeover ? ' paused' : '')}
            onClick={() => void takeControl()}
            aria-label={status?.takeover ? 'Browser paused: you have control' : 'Open BrowserOS'}
            title={status?.takeover ? 'Browser paused: you have control. Tap to open it.' : 'Open BrowserOS'}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
            </svg>
          </button>
          <div className="menu-wrap">
            <button className="icon-button" aria-label="App menu" aria-expanded={appMenu} onClick={() => setAppMenu(v => !v)}>
              ⋮
            </button>
            {appMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setAppMenu(false)} />
                <div className="thread-menu app-menu" role="menu">
                  <button className="menu-item" onClick={() => void reloadApp()}>
                    Reload app
                    <small>Newest page, model list and session index</small>
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      setAppMenu(false);
                      setModuleFocus('');
                      setPanel('modules');
                    }}
                  >
                    Modules
                    <small>Integrations and their settings, such as Bitbucket deploys</small>
                  </button>
                  <button className="menu-item" onClick={() => void toggleNotify()}>
                    {notify ? 'Turn off notifications' : 'Turn on notifications'}
                    <small>When a thread finishes or needs you while this tab is in the background</small>
                  </button>
                  <button className="menu-item" onClick={() => void signOut()}>
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div className="toast" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {notices.length > 0 && (
        <div className="notices" role="status" aria-live="polite">
          {notices.map(notice => (
            <div key={notice.id} className={'notice ' + notice.attention.kind}>
              <button
                className="notice-open"
                onClick={() => {
                  setNotices(list => list.filter(n => n.id !== notice.id));
                  void openById(notice.thread);
                }}
              >
                <i className="attention-dot" />
                <span>
                  <strong>{notice.attention.label}</strong>
                  <small>{notice.title}</small>
                </span>
              </button>
              <button
                className="notice-close"
                aria-label="Dismiss"
                onClick={() => setNotices(list => list.filter(n => n.id !== notice.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <aside className={'sidebar ' + (mobile ? 'visible' : '')}>
        <div className="section-head">
          <span className="eyebrow">LOCAL WORKSPACE</span>
          <span className="badge">Pi engine</span>
        </div>
        <h2>Pick up the context.</h2>
        <p className="muted">
          Pi, Claude Code and Codex history.
          <br />
          New work runs through Pi.
        </p>
        <label className="search-label" htmlFor="search">
          Search history
        </label>
        <input
          id="search"
          className="search"
          placeholder="Ticket, repository, or area…"
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setTab('history');
          }}
        />
        <div className="tabs">
          <button className={tab === 'threads' ? 'active' : ''} onClick={() => setTab('threads')}>
            Threads <span>{threads.length}</span>
            {waiting > 0 && <i className="attention-badge">{waiting}</i>}
          </button>
          {!!inbox?.feeds.length && (
            <button className={tab === 'inbox' ? 'active' : ''} onClick={() => setTab('inbox')}>
              Inbox
              {inboxUnread > 0 ? (
                <i className="attention-badge inbox-badge">{inboxUnread}</i>
              ) : (
                <span>{inbox.requests.filter(request => request.status === 'open').length}</span>
              )}
            </button>
          )}
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
            History <span>{results.length}</span>
          </button>
        </div>
        <div className="session-list">
          {tab === 'inbox' ? (
            <InboxList
              data={inbox}
              refresh={() => void api('/inbox/refresh', {}).then(data => setInbox(fillInbox(data))).catch(report)}
              regroup={() => void api('/inbox/regroup', {}).then(data => setInbox(fillInbox(data))).catch(report)}
              markRequest={markRequest}
              start={startFromInbox}
              openThread={id => void openById(id)}
            />
          ) : tab === 'history' ? (
            <>
              {searching && <small className="muted">Searching locally…</small>}
              {warnings.map(warning => (
                <p className="muted warning" key={warning}>
                  {warning}
                </p>
              ))}
              {results.map(source => (
                <SourceCard
                  key={source.id}
                  source={source}
                  selected={selected.includes(source.id)}
                  inspect={() => void inspect(source.id)}
                  toggle={() => toggleSource(source.id)}
                  open={action => void openFromSession(source, action)}
                />
              ))}
              {!searching && !results.length && (
                <p className="muted">No matching sessions. Try a ticket number or a different area.</p>
              )}
            </>
          ) : (
            threads.map(t => {
              const running = !!t.run && ACTIVE.includes(t.run.status) && t.run.task !== 'stats';
              const background = backgroundLabel(t.background);
              const live = running || !!background;
              const attention = viewing(t.id) ? undefined : t.attention;
              return (
                <button
                  key={t.id}
                  className={'thread-card ' + (thread?.id === t.id ? 'active ' : '') + (attention ? 'waiting ' + attention.kind : '')}
                  onClick={() => void openById(t.id)}
                >
                  <strong>
                    {attention ? (
                      <i className="attention-dot" title={attention.label} />
                    ) : (
                      live && <i className="live-dot" title="Running" />
                    )}
                    {t.title}
                  </strong>
                  <span>
                    {attention ? (
                      <b className="attention-label">{attention.label}</b>
                    ) : running ? (
                      t.run?.activity || 'Running'
                    ) : background ? (
                      background
                    ) : (
                      t.run?.status || 'Ready'
                    )}{' '}
                    · {t.cwd.split('/').pop()}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="index-status">
          <i className={'dot ' + (index?.running ? 'warn' : '')} />
          <span>{indexLabel}</span>
          <button className="quiet" onClick={() => void reindex()}>
            Refresh
          </button>
        </div>
      </aside>

      <main className="workspace">
        {opening || loadingThread ? (
          <LoadingMark label="Opening thread…" />
        ) : !thread ? (
          <FinderPanel
            key={freshStart}
            fresh={freshStart > 0}
            model={model}
            thinking={thinking}
            cwd={cwd}
            setCwd={setCwd}
            selected={selected}
            clearSelected={() => setSelected([])}
            inspect={inspect}
            report={report}
            open={openThread}
          />
        ) : (
          <>
            <header className="thread-bar">
              <i
                className={'dot ' + (status?.takeover ? 'warn' : running ? 'busy' : '')}
                title={thread.run?.activity || thread.run?.status || 'Ready'}
              />
              <h2 title={thread.title}>{thread.title}</h2>
              {running && (
                <span className={'thread-activity' + (compactingNow ? ' compacting' : '')}>
                  {compactingNow ? 'Compacting…' : thread.run?.activity}
                </span>
              )}
              {running && (
                <button
                  className="icon-button danger"
                  title="Stop job"
                  aria-label="Stop job"
                  onClick={() => void api('/threads/' + thread.id + '/stop', {}).then(refresh)}
                >
                  ■
                </button>
              )}
              <div className="menu-wrap model-wrap">
                <button
                  className="model-chip"
                  title={chipTitle}
                  aria-expanded={modelMenu}
                  onClick={() => setModelMenu(open => !open)}
                >
                  <span className="model-name">{shortModel(model || models?.defaults.model || '')}</span>
                  <span className="model-thinking">{thinking || models?.defaults.thinking || ''}</span>
                </button>
                {modelMenu && (
                  <>
                    <div className="menu-backdrop" onClick={() => setModelMenu(false)} />
                    <div className="thread-menu model-menu" role="dialog" aria-label="Model and thinking level">
                      <ModelPicker
                        models={models}
                        model={model}
                        thinking={thinking}
                        setModel={setModel}
                        setThinking={setThinking}
                      />
                    </div>
                  </>
                )}
              </div>
              <BackgroundButton background={thread.background} open={() => setBackgroundOpen(true)} />
              {(!!thread.files?.length || prCount > 0) && (
                <button
                  className="icon-button files-button"
                  title={`Files and pull requests from this thread (${thread.files?.length ?? 0} files, ${prCount} PRs)`}
                  aria-label={`Files, ${thread.files?.length ?? 0}, pull requests, ${prCount}`}
                  onClick={() => setFilesOpen('')}
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                    <path d="M14 3v6h6" />
                  </svg>
                  <span className="files-count">{(thread.files?.length ?? 0) + prCount}</span>
                </button>
              )}
              <ContextMeter
                compacting={compactingNow}
                usage={thread.contextUsage}
                cwd={thread.cwd}
                model={chipModel}
                canCompact={!running && !!thread.messages.length}
                compact={() => void compact()}
              />
              <button
                className={'icon-button' + (compactingNow ? ' compacting' : '')}
                title={compactingNow ? 'Compacting: summarising earlier turns…' : 'Compact context: summarise earlier turns to free space'}
                aria-label={compactingNow ? 'Compacting' : 'Compact context'}
                aria-busy={compactingNow}
                disabled={running || !thread.messages.length}
                onClick={() => void compact()}
              >
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
                </svg>
              </button>
              <button className="icon-button" title="Reload latest messages" aria-label="Reload latest messages" onClick={reloadChat}>
                ↻
              </button>
              <div className="menu-wrap">
                <button
                  className="icon-button"
                  aria-label="Thread options"
                  aria-expanded={menu}
                  onClick={() => setMenu(open => !open)}
                >
                  ⋯
                </button>
                {menu && (
                  <>
                    <div className="menu-backdrop" onClick={() => setMenu(false)} />
                    <div className="thread-menu" role="menu">
                      <label className="check">
                        <input type="checkbox" checked={showThinking} onChange={e => setShowThinking(e.target.checked)} />
                        Show thinking
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={showTools} onChange={e => setShowTools(e.target.checked)} />
                        Show tool calls
                      </label>
                      <button
                        className="menu-item"
                        disabled={!thread.context.length}
                        onClick={() => {
                          setShowContext(true);
                          setMenu(false);
                        }}
                      >
                        {thread.context.length
                          ? `Sources · ${thread.sources.length} sessions, ${thread.context.length} excerpts`
                          : 'Sources appear after the first message'}
                      </button>
                      <button
                        className="menu-item"
                        onClick={() => {
                          setMenu(false);
                          newSession();
                        }}
                      >
                        New thread
                      </button>
                      {thread.origin && (
                        <small className="menu-meta" title={thread.origin.path}>
                          {thread.origin.action === 'continue'
                            ? 'Continuing the original Pi session'
                            : thread.origin.action === 'split'
                              ? `Split from a ${providerName(thread.origin.engine)} session`
                              : `New, with context from a ${providerName(thread.origin.engine)} session`}
                        </small>
                      )}
                      <small className="menu-meta" title={thread.cwd}>
                        {thread.cwd}
                      </small>
                      <small className="menu-meta">
                        Last run: {thread.model || 'Pi default'}
                        {thread.thinking ? ' · ' + thread.thinking : ''}
                      </small>
                      <small className="menu-meta">
                        {thread.run?.status || 'ready'}
                        {thread.run?.activity ? ' · ' + thread.run.activity : ''}
                      </small>
                    </div>
                  </>
                )}
              </div>
            </header>
            {thread.run?.error && (
              <p className="run-error" role="alert">
                {thread.run.error}
              </p>
            )}
            {showContext && thread.context.length > 0 && (
              <div className="context-box">
                <div className="context-head">
                  <span>
                    {thread.sources.length} source sessions · {thread.context.length} cited excerpts
                  </span>
                  <button className="quiet" onClick={() => setShowContext(false)}>
                    Close
                  </button>
                </div>
                {thread.context.map((c: any, i: number) => (
                  <div className="context-entry" key={i}>
                    <button className="quiet" onClick={() => void inspect(c.session)}>
                      {c.engine} · {c.title}
                    </button>
                    <code>
                      {c.path}:{c.line}
                    </code>
                    <p>{c.text}</p>
                  </div>
                ))}
              </div>
            )}
            {status?.takeover && (
              <div className="takeover-banner">
                <span>Browser control is paused for you. Closing the viewer does not resume the agent.</span>
                <button onClick={() => void takeControl()}>Open viewer</button>
                <button className="primary" onClick={() => void release()}>
                  Return control to agent
                </button>
              </div>
            )}
            <div className={'chat ' + (status?.takeover ? 'paused' : '') + (running ? ' busy' : '')}>
              <CopilotKit
                key={thread.id + ':' + chatVersion}
                runtimeUrl="/api/copilotkit"
                agent="pi"
                threadId={thread.id}
                credentials="same-origin"
                showDevConsole={false}
                properties={runProperties}
                enableInspector={false}
              >
                {prefill && <Prefill text={prefill} done={() => setPrefill('')} />}
                <ChatLoading expected={thread.messages.length > 0} />
                <QueueContext.Provider
                  value={{
                    ...queueing,
                    commands,
                    panel: (
                      <>
                        {thread.question && <QuestionCard threadId={thread.id} question={thread.question} api={api} report={report} />}
                        <BackgroundStrip background={thread.background} open={() => setBackgroundOpen(true)} />
                        <QueuePanel
                          thread={thread}
                          running={running}
                          act={async url => {
                            try {
                              await api(url, {});
                            } catch (e) {
                              report(e);
                            }
                            void refresh();
                          }}
                        />
                      </>
                    ),
                  }}
                >
                <DisplayPrefs.Provider value={{thinking: showThinking, tools: showTools}}>
                  <CopilotChat
                    RenderMessage={ChatMessage}
                    attachments={IMAGE_ATTACHMENTS}
                    Input={ChatInput}
                    suggestions={[]}
                    labels={{
                      title: 'Pi',
                      // No greeting bubble: it showed in every thread while its messages were loading.
                      initial: '',
                      placeholder: 'Describe a task or paste a ticket number…',
                      regenerateResponse: 'Retry: run your last message again without this reply',
                    }}
                    onStopGeneration={() => void api('/threads/' + thread.id + '/stop', {})}
                    onInProgress={onChatProgress}
                  />
                </DisplayPrefs.Provider>
                </QueueContext.Provider>
              </CopilotKit>
            </div>
            {activity && (
              <details className="live-output">
                <summary>Saved run output · reconnect-safe</summary>
                <pre>{activity}</pre>
              </details>
            )}
          </>
        )}
      </main>

      {preview && (
        <Preview
          source={preview}
          close={() => setPreview(null)}
          use={() => {
            setSelected(list => (list.includes(preview.id) ? list : [...list.slice(-5), preview.id]));
            setPreview(null);
          }}
          open={action => void openFromSession(preview, action)}
        />
      )}
      {browser && <BrowserPanel hide={() => setBrowser(false)} release={() => void release()} />}
      {lightbox && <Lightbox src={lightbox} close={() => setLightbox('')} />}
      {panel === 'modules' && (
        <ModulesSettings api={api} close={() => setPanel('')} changed={setModuleList} initial={moduleFocus} />
      )}
      {panel === 'terminal' && (
        <Suspense fallback={null}>
          <TerminalPanel api={api} close={() => setPanel('')} />
        </Suspense>
      )}
      {panel === 'actions' && (
        <ActionsPanel
          api={api}
          modules={moduleList}
          close={() => setPanel('')}
          openSettings={() => {
            setModuleFocus('');
            setPanel('modules');
          }}
          openTerminal={() => setPanel('terminal')}
        />
      )}
      {backgroundOpen && thread && (
        <BackgroundPanel threadId={thread.id} api={api} close={() => setBackgroundOpen(false)} report={report} />
      )}
      {thread && filesOpen !== null && (
        <FilesPanel
          thread={thread}
          open={filesOpen}
          setOpen={setFilesOpen}
          close={() => setFilesOpen(null)}
          openSettings={() => {
            setFilesOpen(null);
            setModuleFocus('bitbucket-pull-requests');
            setPanel('modules');
          }}
          report={(e: any) => setError(e.message)}
        />
      )}
    </div>
  );
}

// Drop the cache-busting parameter that Reload app adds.
if (new URLSearchParams(location.search).has('r')) history.replaceState(null, '', urlWith({r: ''}));
createRoot(document.getElementById('root')!).render(<App />);

// Installable app: the service worker only adds an offline page; everything else goes to the network.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
