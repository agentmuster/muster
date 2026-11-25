import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// A shell on the desktop in the browser: xterm.js over a WebSocket to a pty on the desktop. Phones get a
// key bar for the keys their keyboards lack.

type Api = (url: string, body?: unknown) => Promise<any>;
type SessionInfo = {id: string; cwd: string; created: number; attached: number; exited?: number};

const KEYS: [string, string][] = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['|', '|'],
  ['~', '~'],
  ['/', '/'],
  ['-', '-'],
];

function TerminalView(props: {id: string; ended: () => void}) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Connecting…');
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;
  const socket = useRef<WebSocket | null>(null);
  const term = useRef<Terminal | null>(null);

  const send = (data: string) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({type: 'input', data}));
  };

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: window.innerWidth < 620 ? 12 : 13,
      scrollback: 5000,
      theme: {background: '#0d1013', foreground: '#e4e7ec', cursor: '#c9f28d', selectionBackground: '#c9f28d44'},
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(box.current!);
    term.current = terminal;
    fit.fit();

    let closed = false;
    let retries = 0;
    let ws: WebSocket;
    const resize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type: 'resize', cols: terminal.cols, rows: terminal.rows}));
    };
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal/stream?id=${props.id}`);
      socket.current = ws;
      ws.onopen = () => {
        retries = 0;
        setStatus('');
        resize();
      };
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'ready') {
          terminal.reset();
          if (message.replay) terminal.write(message.replay);
          if (message.exited !== undefined) setStatus(`The shell exited (${message.exited}).`);
          terminal.focus();
        } else if (message.type === 'output') {
          terminal.write(message.data);
        } else if (message.type === 'exit') {
          setStatus(`The shell exited (${message.code}).`);
        }
      };
      ws.onclose = event => {
        if (closed) return;
        if (event.code === 1008 || event.code === 1000) {
          setStatus(event.reason || 'Disconnected.');
          if (event.reason === 'Terminal closed') props.ended();
          return;
        }
        if (retries < 6) {
          retries++;
          setStatus('Connection lost. Reconnecting…');
          setTimeout(connect, Math.min(8000, 500 * 2 ** retries));
        } else {
          setStatus('Disconnected. Close and reopen the terminal.');
        }
      };
    };
    connect();

    // Sticky Ctrl from the key bar turns the next letter into its control character.
    terminal.onData(data => {
      if (ctrlRef.current && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        setCtrl(false);
        if (code >= 64 && code <= 95) return send(String.fromCharCode(code - 64));
      }
      send(data);
    });
    const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({type: 'ping'})), 20_000);
    const observer = new ResizeObserver(() => resize());
    observer.observe(box.current!);
    return () => {
      closed = true;
      clearInterval(ping);
      observer.disconnect();
      ws?.close(1000);
      terminal.dispose();
    };
  }, [props.id]);

  return (
    <div className="terminal-view">
      {status && <div className="terminal-status">{status}</div>}
      <div className="terminal-screen" ref={box} />
      <div className="terminal-keys" role="toolbar" aria-label="Terminal keys">
        <button className={ctrl ? 'active' : ''} aria-pressed={ctrl} onClick={() => setCtrl(value => !value)}>
          Ctrl
        </button>
        {KEYS.map(([label, data]) => (
          <button
            key={label}
            onClick={() => {
              send(data);
              term.current?.focus();
            }}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => {
            send('\x03');
            term.current?.focus();
          }}
          title="Ctrl+C"
        >
          ^C
        </button>
      </div>
    </div>
  );
}

export function TerminalPanel(props: {api: Api; close: () => void}) {
  const [info, setInfo] = useState<{enabled: boolean; locked: boolean; sessions: SessionInfo[]; defaultCwd: string} | null>(null);
  const [current, setCurrent] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const data = await props.api('/terminal');
    setInfo(data);
    return data;
  };
  // One tap: opening the panel goes straight to the newest shell, or starts one if none is running.
  useEffect(() => {
    void (async () => {
      const data = await load();
      if (!data.enabled) return;
      const live = data.sessions.filter((s: SessionInfo) => s.exited === undefined);
      if (live.length) setCurrent(live.sort((a: SessionInfo, b: SessionInfo) => b.created - a.created)[0].id);
      else await open(data.defaultCwd);
    })().catch(e => setError(e.message));
  }, []);
  // On phones the on-screen keyboard covers the bottom of the page; keep the panel, and its key bar, above it.
  const [viewport, setViewport] = useState<{height: number; top: number} | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setViewport({height: vv.height, top: vv.offsetTop});
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !current) props.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);

  const open = async (cwd = info?.defaultCwd) => {
    setError('');
    setBusy(true);
    try {
      const created = await props.api('/terminal/sessions', {cwd});
      await load();
      setCurrent(created.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const enable = async (enabled: boolean) => {
    if (enabled && !confirm('Turn on the terminal?\n\nAnyone who can sign in to Muster can then run any command on this desktop as you.')) return;
    setError('');
    try {
      const data = await props.api('/terminal/settings', {enabled}).then(async () => load());
      if (!enabled) setCurrent('');
      // Turning it on opens the first shell right away.
      else await open(data.defaultCwd);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const closeSession = async (id: string) => {
    if (!confirm('Close this terminal? Anything running in it stops.')) return;
    await props.api(`/terminal/sessions/${id}/close`, {}).catch(() => {});
    if (current === id) setCurrent('');
    await load();
  };

  const live = info?.sessions.filter(s => s.exited === undefined) ?? [];
  return createPortal(
    <div
      className="terminal-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Terminal"
      style={viewport ? {top: viewport.top, height: viewport.height, bottom: 'auto'} : undefined}
    >
      <header>
        <strong>Terminal</strong>
        {info?.enabled && (
          <div className="terminal-tabs" role="tablist">
            {live.map((s, index) => (
              <span key={s.id} className={'terminal-tab' + (s.id === current ? ' active' : '')}>
                <button role="tab" aria-selected={s.id === current} onClick={() => setCurrent(s.id)} title={s.cwd}>
                  {index + 1}
                </button>
                <button className="terminal-tab-close" aria-label={`Close terminal ${index + 1}`} onClick={() => void closeSession(s.id)}>
                  ×
                </button>
              </span>
            ))}
            <button onClick={() => void open()} disabled={busy} aria-label="New terminal" title="New terminal">
              +
            </button>
          </div>
        )}
        <button className="icon-button" aria-label="Hide terminal" title="Hide (the shell keeps running)" onClick={props.close}>
          ×
        </button>
      </header>
      {error && <p className="run-error">{error}</p>}
      {!info ? (
        <p className="muted terminal-note">Loading…</p>
      ) : !info.enabled ? (
        <div className="terminal-note">
          <p>
            The terminal runs a shell on this desktop as you, through Muster's sign-in. It is off until you turn it on.
            Sessions are logged by start and end time, not by what you type.
          </p>
          {info.locked ? (
            <p className="muted">It is disabled on this desktop by MUSTER_TERMINAL_DISABLED.</p>
          ) : (
            <button className="primary" onClick={() => void enable(true)}>
              Turn on terminal
            </button>
          )}
        </div>
      ) : current ? (
        <TerminalView key={current} id={current} ended={() => setCurrent('')} />
      ) : (
        <div className="terminal-note">
          <p className="muted">
            {live.length ? 'Pick a terminal above, or open a new one.' : `A new terminal opens in ${info.defaultCwd}.`}
          </p>
          <div className="module-actions">
            <button className="primary" onClick={() => void open()} disabled={busy}>
              New terminal
            </button>
            <button className="quiet" onClick={() => void enable(false)}>
              Turn off terminal
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
