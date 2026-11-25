#!/usr/bin/env python3
"""Local-only search over Pi, Claude Code and Codex transcripts.

Transcripts are read one line at a time and never modified. All output lives in
the private data directory.
"""
import argparse
import contextlib
import hashlib
import json
import math
import os
import pathlib
import re
import sqlite3
import sys
import time
import traceback

os.umask(0o077)

def data_dir():
    """MUSTER_DATA_DIR (or the older META_DATA_DIR), else ~/.local/share/muster unless only the old folder exists."""
    configured = os.environ.get('MUSTER_DATA_DIR') or os.environ.get('META_DATA_DIR')
    if configured:
        return pathlib.Path(configured)
    current = pathlib.Path.home() / '.local/share/muster'
    legacy = pathlib.Path.home() / '.local/share/meta-agent'
    return legacy if not current.exists() and legacy.exists() else current


DATA = data_dir()
HOME = pathlib.Path.home()
ROOTS = [
    ('pi', HOME / '.pi/agent/sessions'),
    ('claude', HOME / '.claude/projects'),
    ('codex', HOME / '.codex/sessions'),
    ('codex', HOME / '.codex/archived_sessions'),
    # Pi sessions of threads started in Muster.
    ('pi', DATA / 'threads'),
]
MAX_LINE = 2 * 1024 * 1024
MAX_MESSAGE = 32000
CHUNK_SIZE = 2000
CHUNK_STRIDE = 1800
SCHEMA_VERSION = '2'

# Redaction is best-effort. Keep this list in step with server/redact.ts.
_KEY_NAMES = (
    r'api[_-]?key|apikey|password|passwd|pwd|secret|client[_-]?secret|'
    r'access[_-]?token|refresh[_-]?token|auth[_-]?token|token|private[_-]?key'
)
SECRET_PATTERNS = [
    (re.compile(r'-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)'),
     '[redacted private key]'),
    (re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'), '[redacted]'),
    (re.compile(r'\bsk-[A-Za-z0-9_-]{16,}'), '[redacted]'),
    (re.compile(r'\bgithub_pat_[A-Za-z0-9_]{20,}'), '[redacted]'),
    (re.compile(r'\bgh[pousr]_[A-Za-z0-9_]{20,}'), '[redacted]'),
    (re.compile(r'\bxox[abposr]-[A-Za-z0-9-]{10,}'), '[redacted]'),
    (re.compile(r'\bAIza[0-9A-Za-z_-]{35}'), '[redacted]'),
    (re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'), '[redacted]'),
    (re.compile(r'(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}'), 'Bearer [redacted]'),
    (re.compile(r'(?i)\bbasic\s+[A-Za-z0-9+/]{12,}={0,2}'), 'Basic [redacted]'),
    (re.compile(r'(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^@\s/]+@'), r'\1[redacted]@'),
    (re.compile(r'(?i)(?<![A-Za-z0-9])((?:[A-Za-z0-9]+[_-])*(?:' + _KEY_NAMES + r')["\']?\s*[:=]\s*)(["\']?)'
                r'[^\s"\',;}]{8,}'), r'\1\2[redacted]'),
]

# Text that coding harnesses inject into the user turn. It is not the owner's prompt.
BOILERPLATE_TAGS = (
    'environment_context', 'recommended_plugins', 'ide_opened_file', 'ide_selection',
    'local-command-caveat', 'local-command-stdout', 'local-command-stderr', 'browser_instruction',
    'system-reminder', 'command-name', 'command-message', 'command-args', 'task-notification',
    'heartbeat', 'mempalace-auto-save', 'codex_internal_context', 'in-app-browser-context',
    'codex_delegation', 'realtime_delegation', 'external_codex_apps_open_page', 'fork-boilerplate',
    'user_instructions', 'INSTRUCTIONS', 'turn_aborted', 'user_shell_command', 'skill',
)
_TAGS = '|'.join(re.escape(t) for t in BOILERPLATE_TAGS)
BOILERPLATE_BLOCK = re.compile(r'<(' + _TAGS + r')\b[^>]*>.*?</\1\s*>', re.S)
BOILERPLATE_OPEN = re.compile(r'^\s*<(?:' + _TAGS + r')\b')
BOILERPLATE_PREFIXES = (
    'Base directory for this skill:',
    '[Request interrupted by user',
    '# AGENTS.md instructions for',
    'Caveat: The messages below were generated',
)

STOP_WORDS = set(
    'a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or '
    'our please so that the then this to was we were what when where which who why will with you your'.split()
)
TICKET = re.compile(r'(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,12})-(\d+)(?![A-Za-z0-9])')
ISSUE = re.compile(r'(?<![\w#])#(\d{2,})(?![\w])')


def redact(text):
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def clean_user_text(text):
    """Remove harness-injected blocks. Returns '' when nothing the owner typed is left."""
    text = BOILERPLATE_BLOCK.sub('', text).strip()
    if BOILERPLATE_OPEN.match(text) or text.startswith(BOILERPLATE_PREFIXES):
        return ''
    return text


class StaleSchema(RuntimeError):
    pass


def connect(data=DATA, reset_stale=False):
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(data, 0o700)
    db = sqlite3.connect(str(data / 'index.sqlite'), timeout=20)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)')
    row = db.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
    has_sessions = db.execute("SELECT 1 FROM sqlite_master WHERE name='sessions'").fetchone()
    if has_sessions and (not row or row['value'] != SCHEMA_VERSION):
        if not reset_stale:
            db.close()
            raise StaleSchema('The index format changed. Refresh the index to rebuild it.')
        db.executescript('''
            DROP TRIGGER IF EXISTS chunks_ai;
            DROP TRIGGER IF EXISTS chunks_ad;
            DROP TABLE IF EXISTS search;
            DROP TABLE IF EXISTS chunks;
            DROP TABLE IF EXISTS sessions;
        ''')
        with contextlib.suppress(FileNotFoundError):
            (data / 'semantic.npz').unlink()
    db.executescript('''
        CREATE TABLE IF NOT EXISTS sessions(
            id TEXT PRIMARY KEY, native_id TEXT, engine TEXT, path TEXT UNIQUE, cwd TEXT, title TEXT,
            modified REAL, size INTEGER, sidechain INTEGER, messages INTEGER, branch TEXT);
        CREATE TABLE IF NOT EXISTS chunks(
            id INTEGER PRIMARY KEY, session_id TEXT, line INTEGER, role TEXT, text TEXT, branch TEXT);
        CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id, id);
        CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
            text, content=chunks, content_rowid=id, tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO search(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO search(search, rowid, text) VALUES ('delete', old.id, old.text);
        END;
    ''')
    db.execute("INSERT OR REPLACE INTO meta VALUES('schema', ?)", (SCHEMA_VERSION,))
    db.commit()
    os.chmod(data / 'index.sqlite', 0o600)
    return db


def text_content(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    parts = []
    for block in content:
        if (isinstance(block, dict)
                and block.get('type') in ('text', 'input_text', 'output_text')
                and isinstance(block.get('text'), str)):
            parts.append(block['text'])
    return '\n'.join(parts)


def records(path):
    with open(path, 'rb') as f:
        number = 0
        while True:
            raw = f.readline(MAX_LINE + 1)
            if not raw:
                break
            number += 1
            if len(raw) > MAX_LINE:
                while raw and not raw.endswith(b'\n'):
                    raw = f.readline(MAX_LINE + 1)
                continue
            # A writer may still be appending its last record.
            if not raw.endswith(b'\n'):
                continue
            try:
                record = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(record, dict):
                yield number, record


# sessions.sidechain: 0 main conversation, 1 subagent run, MIRROR a Claude Code copy of a Pi session.
MIRROR = 2
# pi-claude-bridge serves Pi's tools to Claude Code from an MCP server named custom-tools.
BRIDGE_TOOL_PREFIX = 'mcp__custom-tools__'
_bridge_sessions = None


def bridge_sessions():
    """Claude Code session ids that pi-claude-bridge recorded as belonging to a Pi session."""
    global _bridge_sessions
    if _bridge_sessions is None:
        _bridge_sessions = set()
        agent_dir = pathlib.Path(os.environ.get('PI_CODING_AGENT_DIR', pathlib.Path.home() / '.pi/agent'))
        folder = agent_dir / 'claude-bridge/sessions'
        for state in folder.glob('s-*.json') if folder.exists() else []:
            try:
                session_id = json.loads(state.read_text()).get('ccSessionId')
            except (OSError, ValueError):
                continue
            if isinstance(session_id, str):
                _bridge_sessions.add(session_id)
    return _bridge_sessions


def parse_session(path, engine):
    meta = {'native_id': path.stem, 'cwd': '', 'title': '', 'name': '',
            'sidechain': int('/subagents/' in str(path)), 'branch': ''}
    # (line, role, text, branch, origin)
    entries = []
    for line, d in records(path):
        kind = d.get('type')
        branch = str(d.get('parentId') or d.get('parentUuid') or '')[:128]
        if engine == 'pi':
            if kind == 'session':
                meta['native_id'] = str(d.get('id', path.stem))
                meta['cwd'] = str(d.get('cwd') or '')
            elif kind == 'session_info' and isinstance(d.get('name'), str) and d['name'].strip():
                meta['name'] = d['name']
                # pi-subagents names its child sessions subagent-<agent>-<run>.
                if d['name'].startswith('subagent-'):
                    meta['sidechain'] = 1
            elif kind == 'message':
                m = d.get('message') or {}
                entries.append((line, m.get('role'), text_content(m.get('content')), branch, 'message'))
            elif kind in ('compaction', 'branch_summary'):
                entries.append((line, 'summary', str(d.get('summary') or ''), branch, 'message'))
        elif engine == 'claude':
            if d.get('cwd'):
                meta['cwd'] = str(d['cwd'])
            if d.get('sessionId'):
                meta['native_id'] = str(d['sessionId'])
            if d.get('gitBranch'):
                meta['branch'] = str(d['gitBranch'])
            if d.get('isSidechain'):
                meta['sidechain'] = 1
            if kind in ('user', 'assistant'):
                m = d.get('message') or {}
                entries.append((line, m.get('role', kind), text_content(m.get('content')), branch, 'message'))
                if kind == 'assistant' and not meta.get('mirror'):
                    content = m.get('content')
                    if isinstance(content, list) and any(
                            isinstance(b, dict) and b.get('type') == 'tool_use'
                            and str(b.get('name', '')).startswith(BRIDGE_TOOL_PREFIX) for b in content):
                        meta['mirror'] = True
        else:
            p = d.get('payload') or {}
            if kind == 'session_meta':
                meta['native_id'] = str(p.get('session_id') or p.get('id') or path.stem)
                meta['cwd'] = str(p.get('cwd') or '')
            elif kind == 'response_item' and p.get('type') == 'message':
                entries.append((line, p.get('role'), text_content(p.get('content')), branch, 'response'))
            elif kind == 'event_msg' and p.get('type') in ('user_message', 'agent_message'):
                role = 'user' if p['type'] == 'user_message' else 'assistant'
                entries.append((line, role, str(p.get('message') or ''), branch, 'event'))

    if engine == 'codex':
        # event_msg.user_message is the prompt the owner typed. The response_item copy also
        # carries injected context. Assistant text is most complete in response_item.
        event_users = any(e[1] == 'user' and e[4] == 'event' for e in entries)
        response_assistants = any(e[1] == 'assistant' and e[4] == 'response' for e in entries)
        entries = [
            e for e in entries
            if (e[1] == 'user' and (e[4] == 'event') == event_users)
            or (e[1] == 'assistant' and (e[4] == 'response') == response_assistants)
        ]

    messages, seen, first_prompt = [], set(), ''
    for line, role, text, branch, _origin in entries:
        if role not in ('user', 'assistant', 'summary') or not isinstance(text, str):
            continue
        # System/developer prompts, thinking, tool results and images are never indexed.
        if role == 'user':
            text = clean_user_text(text)
        text = redact(text.strip())[:MAX_MESSAGE]
        if not text:
            continue
        key = (role, hashlib.sha256(text.encode()).hexdigest())
        if key in seen:
            continue
        seen.add(key)
        if not first_prompt and role == 'user':
            first_prompt = re.sub(r'\s+', ' ', text)[:160]
        messages.append((line, role, text, branch))

    if engine == 'claude' and (meta.pop('mirror', False) or path.stem in bridge_sessions()):
        # Pi's claude-bridge runs Claude Code underneath; the Pi session holds the same conversation.
        meta['sidechain'] = MIRROR
        messages = []

    name = redact(re.sub(r'\s+', ' ', meta.pop('name')).strip())[:180]
    meta['title'] = name or first_prompt or path.stem
    meta['cwd'] = redact(meta['cwd'])
    return meta, messages


def status(data, state):
    target = data / 'index-status.json'
    tmp = target.with_suffix('.tmp')
    tmp.write_text(json.dumps(state))
    os.chmod(tmp, 0o600)
    tmp.replace(target)


SEMANTIC_INTERVAL = int(os.environ.get('MUSTER_SEMANTIC_INTERVAL') or os.environ.get('META_SEMANTIC_INTERVAL') or '600')


def index(data=DATA, roots=ROOTS, force_semantic=False):
    import fcntl
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(data / 'index.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Index already running')
        db = connect(data, reset_stale=True)
        files = []
        for engine, root in roots:
            if root.exists():
                files.extend((engine, p) for p in root.rglob('*.jsonl') if p.is_file() and not p.is_symlink())
        state = {'running': True, 'pid': os.getpid(), 'total': len(files), 'processed': 0, 'updated': 0,
                 'errors': 0, 'skipped': 0, 'started': time.time(), 'phase': 'reading'}
        status(data, state)
        paths = set()
        try:
            for engine, path in files:
                state['processed'] += 1
                try:
                    path = path.resolve()
                    st = path.stat()
                except FileNotFoundError:
                    # Deleted between the directory scan and now.
                    state['skipped'] += 1
                    continue
                paths.add(str(path))
                previous = db.execute('SELECT modified, size FROM sessions WHERE path=?', (str(path),)).fetchone()
                if previous and previous['modified'] == st.st_mtime and previous['size'] == st.st_size:
                    if state['processed'] % 25 == 0:
                        status(data, state)
                    continue
                try:
                    meta, messages = parse_session(path, engine)
                    store_session(db, path, engine, st, meta, messages)
                    state['updated'] += 1
                except FileNotFoundError:
                    paths.discard(str(path))
                    state['skipped'] += 1
                except (OSError, ValueError, sqlite3.Error):
                    state['errors'] += 1
                status(data, state)
            with db:
                for row in db.execute('SELECT id, path FROM sessions').fetchall():
                    if row['path'] not in paths:
                        db.execute('DELETE FROM chunks WHERE session_id=?', (row['id'],))
                        db.execute('DELETE FROM sessions WHERE id=?', (row['id'],))
            model = data / 'semantic.npz'
            newest = db.execute('SELECT MAX(modified) FROM sessions').fetchone()[0] or 0
            model_age = time.time() - model.stat().st_mtime if model.exists() else None
            # Background runs keep keyword search current every time but rebuild the related-topic model
            # at most every SEMANTIC_INTERVAL seconds; a manual refresh rebuilds whenever anything changed.
            stale = model_age is None or newest > model.stat().st_mtime
            due = model_age is None or force_semantic or model_age >= SEMANTIC_INTERVAL
            if stale and due:
                state['phase'] = 'local semantic model'
                status(data, state)
                state['semantic'] = build_semantic(db, data)
            else:
                state['semantic'] = 'pending' if stale else 'unchanged'
            state.update(
                running=False, phase='ready', finished=time.time(),
                sessions=db.execute('SELECT count(*) FROM sessions WHERE sidechain != ?', (MIRROR,)).fetchone()[0],
                mirrors=db.execute('SELECT count(*) FROM sessions WHERE sidechain = ?', (MIRROR,)).fetchone()[0],
                chunks=db.execute('SELECT count(*) FROM chunks').fetchone()[0],
            )
            status(data, state)
            return state
        except Exception as error:
            state.update(running=False, phase='failed', errors=state['errors'] + 1,
                         error=redact(f'{type(error).__name__}: {error}')[:500])
            status(data, state)
            raise
        finally:
            db.close()


def store_session(db, path, engine, st, meta, messages):
    session_id = hashlib.sha256(str(path).encode()).hexdigest()[:24]
    with db:
        db.execute('DELETE FROM chunks WHERE session_id=?', (session_id,))
        db.execute(
            'INSERT OR REPLACE INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (session_id, meta['native_id'], engine, str(path), meta['cwd'], meta['title'],
             st.st_mtime, st.st_size, meta['sidechain'], len(messages), meta['branch']),
        )
        for line, role, text, branch in messages:
            for start in range(0, len(text), CHUNK_STRIDE):
                db.execute(
                    'INSERT INTO chunks(session_id, line, role, text, branch) VALUES(?,?,?,?,?)',
                    (session_id, line, role, text[start:start + CHUNK_SIZE], branch),
                )


def _vectorizer(**options):
    from sklearn.feature_extraction.text import TfidfVectorizer
    return TfidfVectorizer(ngram_range=(1, 2), stop_words='english', sublinear_tf=True, **options)


def build_semantic(db, data):
    """Latent semantic model: TF-IDF over one bounded document per session, reduced with SVD."""
    import numpy as np
    from sklearn.decomposition import TruncatedSVD
    rows = db.execute('SELECT id, title FROM sessions WHERE sidechain != ? ORDER BY id', (MIRROR,)).fetchall()
    docs = []
    for row in rows:
        chunks = db.execute(
            'SELECT text FROM chunks WHERE session_id=? ORDER BY id LIMIT 18', (row['id'],)).fetchall()
        docs.append(row['title'] + '\n' + '\n'.join(c['text'] for c in chunks))
    if len(docs) < 3:
        return 'skipped: fewer than three sessions'
    vectorizer = _vectorizer(max_features=18000)
    try:
        matrix = vectorizer.fit_transform(docs)
    except ValueError as error:
        return f'skipped: {error}'
    terms = vectorizer.get_feature_names_out()
    dims = min(96, matrix.shape[0] - 1, matrix.shape[1] - 1)
    if dims < 2:
        return 'skipped: vocabulary too small'
    svd = TruncatedSVD(n_components=dims, random_state=42)
    vectors = svd.fit_transform(matrix)
    vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
    tmp = data / 'semantic.tmp.npz'
    # Unicode arrays, not object arrays, so the model loads with allow_pickle=False.
    np.savez_compressed(
        tmp,
        ids=np.array([r['id'] for r in rows], dtype=str),
        terms=np.array(terms, dtype=str),
        idf=vectorizer.idf_.astype(np.float32),
        components=svd.components_.astype(np.float32),
        vectors=vectors.astype(np.float32),
    )
    os.chmod(tmp, 0o600)
    tmp.replace(data / 'semantic.npz')
    semantic_search('verification query', data)
    return 'ready'


_semantic_cache = {}


def semantic_search(query, data, limit=80):
    """Cosine similarity between the query and each session in latent space."""
    import numpy as np
    path = data / 'semantic.npz'
    if not path.exists():
        raise FileNotFoundError('semantic model has not been built')
    mtime = path.stat().st_mtime
    cached = _semantic_cache.get(str(path))
    if not cached or cached['mtime'] != mtime:
        with np.load(path, allow_pickle=False) as m:
            cached = {
                'mtime': mtime,
                'ids': m['ids'],
                'vocabulary': {str(t): i for i, t in enumerate(m['terms'])},
                'idf': m['idf'],
                'components': m['components'],
                'vectors': m['vectors'],
            }
        _semantic_cache[str(path)] = cached
    counts = {}
    for term in _vectorizer().build_analyzer()(query):
        index_ = cached['vocabulary'].get(term)
        if index_ is not None:
            counts[index_] = counts.get(index_, 0) + 1
    if not counts:
        return {}
    weights = np.zeros(len(cached['idf']), dtype=np.float32)
    for index_, count in counts.items():
        weights[index_] = (1 + math.log(count)) * cached['idf'][index_]
    weights /= max(float(np.linalg.norm(weights)), 1e-12)
    projected = cached['components'] @ weights
    norm = float(np.linalg.norm(projected))
    if norm < 1e-12:
        return {}
    scores = cached['vectors'] @ (projected / norm)
    top = np.argsort(scores)[-limit:]
    return {str(cached['ids'][i]): float(scores[i]) for i in top if scores[i] > 0.05}


def query_terms(query):
    tokens = []
    for token in re.findall(r'\w+', query.lower()):
        if token not in tokens:
            tokens.append(token)
    content = [t for t in tokens if t not in STOP_WORDS and (len(t) > 1 or t.isdigit())]
    return (content or tokens)[:16]


def ticket_patterns(query):
    """(fts phrase, verification regex) for each ticket key or #issue number in the query."""
    patterns = []
    for key, number in TICKET.findall(query):
        regex = re.compile(r'(?<![A-Za-z0-9])' + re.escape(key) + r'-' + number + r'(?!\d)', re.I)
        patterns.append(('"%s %s"' % (key, number), regex))
    for number in ISSUE.findall(query):
        patterns.append(('"%s"' % number, re.compile(r'#' + number + r'(?!\d)')))
    return patterns


def _excerpt(text, match=None, size=500):
    if not match:
        return text[:size]
    start = max(0, match.start() - size // 3)
    return text[start:start + size]


def ticket_hits(db, query, session_id=None):
    """Exact ticket matches, verified with a regex. Not capped by the lexical result pool."""
    hits = {}
    for phrase, regex in ticket_patterns(query):
        sql = ('SELECT c.id, c.session_id, c.line, c.role, c.text, c.branch '
               'FROM search JOIN chunks c ON c.id = search.rowid WHERE search MATCH ?')
        params = [phrase]
        if session_id:
            sql += ' AND c.session_id = ?'
            params.append(session_id)
        for row in db.execute(sql, params):
            match = regex.search(row['text'])
            if match:
                hits.setdefault(row['session_id'], []).append((row, match))
    return hits


def lexical(db, terms, limit=600):
    """Per-session keyword relevance in 0..1.1, relative to the best chunk for this query."""
    if not terms:
        return {}
    fts = ' OR '.join('"%s"' % t for t in terms)
    rows = db.execute(
        'SELECT c.session_id, c.text, bm25(search) AS relevance FROM search '
        'JOIN chunks c ON c.id = search.rowid WHERE search MATCH ? ORDER BY relevance LIMIT ?',
        (fts, limit),
    ).fetchall()
    if not rows or rows[0]['relevance'] >= 0:
        return {}
    best = rows[0]['relevance']
    wanted = set(terms)
    sessions = {}
    for row in rows:
        relative = row['relevance'] / best
        s = sessions.setdefault(row['session_id'], {'best': 0.0, 'count': 0, 'terms': set(), 'excerpt': ''})
        if relative > s['best']:
            s['best'] = relative
            s['excerpt'] = row['text'][:500]
        s['count'] += 1
        s['terms'] |= wanted.intersection(re.findall(r'\w+', row['text'].lower()))
    scores = {}
    for session_id, s in sessions.items():
        coverage = len(s['terms']) / len(wanted)
        repeated = min(1.0, (s['count'] - 1) / 5)
        scores[session_id] = (0.45 * s['best'] + 0.45 * coverage + 0.10 * repeated, s['excerpt'])
    return scores


def search(query, data=DATA, engine=None, limit=40):
    warnings = []
    try:
        db = connect(data)
    except StaleSchema as error:
        return {'results': [], 'warnings': [str(error)]}
    try:
        terms = query_terms(query)
        tickets = ticket_hits(db, query)
        if not terms and not tickets:
            rows = db.execute('SELECT * FROM sessions WHERE sidechain != ? ORDER BY modified DESC LIMIT ?',
                              (MIRROR, limit)).fetchall()
            results = [dict(r, score=0, excerpt='', ticket=False) for r in rows
                       if not engine or r['engine'] == engine]
            return {'results': results, 'warnings': warnings}
        keyword = lexical(db, terms)
        try:
            semantic = semantic_search(query, data)
        except Exception as error:  # Reported to the caller, never silently dropped.
            semantic = {}
            warnings.append(f'Related-area search unavailable ({type(error).__name__}: {error}). '
                            'Keyword and ticket search still work.')
        now, phrase = time.time(), query.lower().strip()
        results = []
        for session_id in set(keyword) | set(semantic) | set(tickets):
            row = db.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
            if not row or row['sidechain'] == MIRROR or (engine and row['engine'] != engine):
                continue
            keyword_score, excerpt = keyword.get(session_id, (0.0, ''))
            semantic_score = max(0.0, semantic.get(session_id, 0.0))
            score = 0.65 * keyword_score + 0.35 * semantic_score
            age_days = max(0.0, (now - row['modified']) / 86400)
            score += 0.05 * math.exp(-age_days / 60)
            if phrase and phrase in (row['title'] + ' ' + row['cwd']).lower():
                score += 0.1
            is_ticket = session_id in tickets
            if is_ticket:
                score += 10
                first_row, match = tickets[session_id][0]
                excerpt = _excerpt(first_row['text'], match)
            if not excerpt:
                first = db.execute('SELECT text FROM chunks WHERE session_id=? ORDER BY id LIMIT 1',
                                   (session_id,)).fetchone()
                excerpt = first['text'][:500] if first else ''
            results.append(dict(row, score=round(score, 4), excerpt=excerpt, ticket=is_ticket,
                                keyword=round(keyword_score, 3), semantic=round(semantic_score, 3)))
        results.sort(key=lambda r: (r['score'], r['modified']), reverse=True)
        return {'results': results[:limit], 'warnings': warnings}
    finally:
        db.close()


def preview(session_id, data=DATA):
    db = connect(data)
    try:
        row = db.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        chunks = db.execute(
            'SELECT line, role, text, branch FROM chunks WHERE session_id=? ORDER BY id DESC LIMIT 36',
            (session_id,)).fetchall()
        result['chunks'] = [dict(c) for c in chunks][::-1]
        return result
    finally:
        db.close()


def context(session_ids, query, data=DATA, budget=18000):
    """Cited excerpts for the selected sessions: ticket matches first, then keyword matches."""
    db = connect(data)
    out, remaining = [], budget
    terms = query_terms(query)
    try:
        for session_id in session_ids[:6]:
            row = db.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
            if not row:
                continue
            chosen, seen = [], set()
            for found, _match in ticket_hits(db, query, session_id).get(session_id, [])[:2]:
                chosen.append(found)
                seen.add(found['id'])
            if terms and len(chosen) < 4:
                fts = ' OR '.join('"%s"' % t for t in terms)
                for found in db.execute(
                        'SELECT c.id, c.line, c.role, c.text, c.branch FROM search '
                        'JOIN chunks c ON c.id = search.rowid WHERE search MATCH ? AND c.session_id = ? '
                        'ORDER BY bm25(search) LIMIT 6', (fts, session_id)):
                    if found['id'] not in seen and len(chosen) < 4:
                        chosen.append(found)
                        seen.add(found['id'])
            if not chosen:
                chosen = db.execute(
                    'SELECT id, line, role, text, branch FROM chunks WHERE session_id=? ORDER BY id DESC LIMIT 4',
                    (session_id,)).fetchall()[::-1]
            for chunk in chosen:
                text = chunk['text'][:min(2000, remaining)]
                if not text:
                    break
                out.append({'session': session_id, 'engine': row['engine'], 'title': row['title'],
                            'path': row['path'], 'line': chunk['line'], 'branch': chunk['branch'],
                            'role': chunk['role'], 'text': text})
                remaining -= len(text)
        return out
    finally:
        db.close()


def recent(data=DATA, limit=25, engine=None, contains='', include_subagents=False):
    """Most recently changed sessions, optionally filtered by engine or a title/directory substring."""
    db = connect(data)
    try:
        rows = db.execute('SELECT * FROM sessions ORDER BY modified DESC LIMIT 2000').fetchall()
        needle = (contains or '').lower().strip()
        out = []
        for row in rows:
            if engine and row['engine'] != engine:
                continue
            if row['sidechain'] == MIRROR or (row['sidechain'] and not include_subagents):
                continue
            if needle and needle not in (row['title'] + ' ' + row['cwd']).lower():
                continue
            out.append(dict(row))
            if len(out) >= limit:
                break
        return out
    finally:
        db.close()


def brief(session_id, query='', data=DATA, budget=7000):
    """A bounded look inside one session: how it started, where it ended, and the parts matching the query."""
    db = connect(data)
    try:
        row = db.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
        if not row:
            return None
        pick = 'SELECT id, line, role, text FROM chunks WHERE session_id=?'
        opening = db.execute(pick + " AND role='user' ORDER BY id LIMIT 2", (session_id,)).fetchall()
        ending = db.execute(pick + ' ORDER BY id DESC LIMIT 8', (session_id,)).fetchall()[::-1]
        matching = []
        terms = query_terms(query)
        if terms:
            fts = ' OR '.join('"%s"' % t for t in terms)
            matching = db.execute(
                'SELECT c.id, c.line, c.role, c.text FROM search JOIN chunks c ON c.id = search.rowid '
                'WHERE search MATCH ? AND c.session_id = ? ORDER BY bm25(search) LIMIT 4',
                (fts, session_id)).fetchall()
        remaining = budget

        def take(chunks, size):
            nonlocal remaining
            out = []
            for chunk in chunks:
                text = chunk['text'][:min(size, remaining)]
                if not text:
                    break
                out.append({'line': chunk['line'], 'role': chunk['role'], 'text': text})
                remaining -= len(text)
            return out

        result = {key: row[key] for key in ('id', 'engine', 'title', 'cwd', 'branch', 'modified', 'messages',
                                              'sidechain')}
        result['opening'] = take(opening, 900)
        result['matching'] = take(matching, 700)
        result['ending'] = take(ending, 700)
        return result
    finally:
        db.close()


def meta(session_ids, data=DATA):
    db = connect(data)
    try:
        out = {}
        for session_id in session_ids[:50]:
            row = db.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
            if row:
                out[session_id] = dict(row)
        return out
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['index', 'search', 'preview', 'context', 'recent', 'brief', 'meta'])
    parser.add_argument('value', nargs='?', default='')
    args = parser.parse_args()
    if args.command == 'index':
        result = index(force_semantic=args.value == 'full')
    elif args.command == 'search':
        result = search(args.value)
    elif args.command == 'preview':
        result = preview(args.value)
    elif args.command in ('recent', 'brief', 'meta'):
        request = json.loads(sys.stdin.read() or '{}')
        if args.command == 'recent':
            result = recent(limit=min(int(request.get('limit') or 25), 60), engine=request.get('engine') or None,
                            contains=str(request.get('contains') or ''))
        elif args.command == 'brief':
            result = brief(str(request.get('id') or ''), str(request.get('query') or ''))
        else:
            result = meta([str(x) for x in request.get('ids', [])])
    else:
        request = json.loads(sys.stdin.read() or '{}')
        result = context(request.get('sources', []), request.get('query', ''))
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write(redact(traceback.format_exc())[-2000:])
        sys.exit(1)
