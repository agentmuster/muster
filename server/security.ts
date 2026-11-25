import {createHash, createPublicKey, randomBytes, scryptSync, timingSafeEqual, verify, type KeyObject} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import type {IncomingMessage} from 'node:http';
import {createAccount, writePrivate} from './account.js';
import {defaultDataDir} from './env.js';

export const DATA = defaultDataDir();
// Child processes (the indexer, Pi and its extensions) use the same folder.
process.env.MUSTER_DATA_DIR = DATA;
mkdirSync(DATA, {recursive: true, mode: 0o700});
chmodSync(DATA, 0o700);
export const PORT = Number(process.env.PORT || 47831);

export function savePrivate(file: string, value: unknown) {
  writePrivate(file, JSON.stringify(value, null, 2));
}

// Account

const authFile = path.join(DATA, 'auth.json');
if (!existsSync(authFile)) createAccount(DATA);
const account = JSON.parse(readFileSync(authFile, 'utf8')) as {salt: string; hash: string};

export function verifyPassword(password: unknown) {
  if (typeof password !== 'string' || password.length > 200) return false;
  const actual = scryptSync(password, account.salt, 64);
  return timingSafeEqual(actual, Buffer.from(account.hash, 'hex'));
}

// Allowed hosts: MUSTER_ALLOWED_HOSTS plus the private DATA/allowed-hosts file, re-read when it changes.

const HOST_PATTERN = /^[a-z0-9.-]+(?::\d{1,5})?$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

function parseHosts(text: string) {
  return text
    .split(/[\n,]/)
    .map(line => line.replace(/#.*/, '').trim().toLowerCase())
    .filter(host => HOST_PATTERN.test(host));
}

export class AllowedHosts {
  private cached = {mtimeMs: -1, size: -1, hosts: [] as string[]};
  private warned = false;

  constructor(private readonly file: string, private readonly fromEnv: () => string) {}

  list(): Set<string> {
    const hosts = new Set(parseHosts(this.fromEnv()));
    let stat;
    try {
      stat = statSync(this.file);
    } catch {
      this.cached = {mtimeMs: -1, size: -1, hosts: []};
      return hosts;
    }
    if (stat.mtimeMs !== this.cached.mtimeMs || stat.size !== this.cached.size) {
      const privateFile = (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.();
      if (!privateFile && !this.warned) {
        console.warn(`Ignoring ${this.file}: it must be owned by this user with mode 600.`);
        this.warned = true;
      }
      const entries = privateFile ? parseHosts(readFileSync(this.file, 'utf8')) : [];
      this.cached = {mtimeMs: stat.mtimeMs, size: stat.size, hosts: entries};
    }
    for (const host of this.cached.hosts) hosts.add(host);
    return hosts;
  }
}

export const allowedHosts = new AllowedHosts(
  path.join(DATA, 'allowed-hosts'),
  () => process.env.MUSTER_ALLOWED_HOSTS || `127.0.0.1:${PORT},localhost:${PORT}`,
);
export const hosts = () => allowedHosts.list();

const isLoopbackHost = (host: string) => LOOPBACK_HOSTNAMES.has(host.split(':')[0]);
export const originFor = (host: string) => (isLoopbackHost(host) ? 'http://' : 'https://') + host;
export const socketOriginFor = (host: string) => (isLoopbackHost(host) ? 'ws://' : 'wss://') + host;
export const allowedOrigins = () => [...hosts()].map(originFor);

export function allowedHost(req: IncomingMessage) {
  return typeof req.headers.host === 'string' && hosts().has(req.headers.host.toLowerCase());
}

export function allowedOrigin(req: IncomingMessage, required = true) {
  const origin = req.headers.origin;
  if (!origin) return !required;
  const host = (req.headers.host || '').toLowerCase();
  try {
    const url = new URL(origin);
    return url.host === host && hosts().has(host) && url.origin === originFor(host);
  } catch {
    return false;
  }
}

export const csrfSafe = (req: IncomingMessage) => allowedHost(req) && allowedOrigin(req, true);

export function secureRequest(req: IncomingMessage) {
  const hostname = (req.headers.host || '').split(':')[0];
  return req.headers['x-forwarded-proto'] === 'https' || !LOOPBACK_HOSTNAMES.has(hostname);
}

export function cookie(req: IncomingMessage) {
  const match = (req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('meta_session='));
  return match ? match.slice('meta_session='.length) : '';
}

export function sessionCookie(token: string, secure: boolean) {
  return `meta_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`;
}

export function isLoopbackAddress(address: string | undefined) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '');
}

// Login throttling

type Window = {count: number; since: number};
const httpError = (message: string, status: number) => Object.assign(new Error(message), {status});

export class LoginThrottle {
  private perClient = new Map<string, Window>();
  private global: Window = {count: 0, since: Date.now()};

  constructor(readonly perClientLimit = 8, readonly globalLimit = 200, readonly windowMs = 15 * 60_000) {}

  /**
   * Behind cloudflared every request arrives from loopback, so the socket address alone would put the
   * whole internet in one bucket. Cloudflare overwrites CF-Connecting-IP at its edge, so it is trusted
   * only when the peer is loopback and the owner opted in.
   */
  clientKey(req: IncomingMessage) {
    const peer = req.socket.remoteAddress || 'unknown';
    const forwarded = req.headers['cf-connecting-ip'];
    if (
      process.env.MUSTER_TRUST_CF_CONNECTING_IP === '1' &&
      isLoopbackAddress(peer) &&
      typeof forwarded === 'string' &&
      /^[0-9a-fA-F:.]{2,45}$/.test(forwarded)
    ) {
      return 'cf:' + forwarded.toLowerCase();
    }
    return 'peer:' + peer;
  }

  private current(window: Window | undefined, now: number) {
    return !window || now - window.since > this.windowMs ? {count: 0, since: now} : window;
  }

  /** Records an attempt before the password is checked, so concurrent guesses are counted. */
  begin(key: string) {
    const now = Date.now();
    this.global = this.current(this.global, now);
    const client = this.current(this.perClient.get(key), now);
    this.perClient.set(key, client);
    if (this.global.count >= this.globalLimit) {
      throw httpError('Too many sign-in attempts from all clients. Try again in 15 minutes.', 429);
    }
    if (client.count >= this.perClientLimit) throw httpError('Too many attempts. Try again in 15 minutes.', 429);
    client.count++;
    this.global.count++;
  }

  succeeded(key: string) {
    this.perClient.delete(key);
    this.global.count = Math.max(0, this.global.count - 1);
  }
}

// Cloudflare Access

/**
 * Verifies the Cf-Access-Jwt-Assertion header that Cloudflare Access adds to requests it let through.
 * The header alone proves nothing, since anything on this desktop can reach the app directly; the token's
 * RS256 signature, issuer, audience, expiry and email are all checked against the team's published keys.
 */
export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private fetching?: Promise<void>;

  constructor(
    readonly team: string,
    readonly audience: string,
    readonly emails: string[],
    private fetchKeys: () => Promise<any> = () =>
      fetch(`https://${team}/cdn-cgi/access/certs`, {signal: AbortSignal.timeout(8000)}).then(r => r.json()),
  ) {}

  refresh() {
    this.fetching ??= this.fetchKeys()
      .then(body => {
        const next = new Map<string, KeyObject>();
        for (const jwk of body?.keys ?? []) {
          if (typeof jwk?.kid === 'string' && jwk.kty === 'RSA') next.set(jwk.kid, createPublicKey({key: jwk, format: 'jwk'}));
        }
        if (next.size) {
          this.keys = next;
          this.fetchedAt = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => {
        this.fetching = undefined;
      });
    return this.fetching;
  }

  verify(token: string): {email: string; subject: string; expires: number} | undefined {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 8192) return undefined;
    let header: any;
    let claims: any;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return undefined;
    const key = this.keys.get(header.kid);
    if (!key) {
      // Cloudflare rotates keys; fetch again, at most once a minute.
      if (Date.now() - this.fetchedAt > 60_000) void this.refresh();
      return undefined;
    }
    const signed = verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
    if (!signed) return undefined;
    const now = Date.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.audience)) return undefined;
    if (claims.iss !== `https://${this.team}`) return undefined;
    if (typeof claims.exp !== 'number' || claims.exp < now) return undefined;
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return undefined;
    const email = String(claims.email ?? '').toLowerCase();
    if (!this.emails.includes(email)) return undefined;
    return {email, subject: String(claims.sub || email), expires: claims.exp * 1000};
  }
}

function accessFromEnv() {
  const team = process.env.MUSTER_ACCESS_TEAM?.trim();
  const audience = process.env.MUSTER_ACCESS_AUD?.trim();
  const emails = (process.env.MUSTER_ACCESS_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!team || !audience || !emails.length) return undefined;
  const verifier = new AccessVerifier(team, audience, emails);
  void verifier.refresh();
  setInterval(() => void verifier.refresh(), 60 * 60_000).unref();
  return verifier;
}

// Sessions

/** access marks sign-ins proven by Cloudflare Access; they are rebuilt from the token, never saved. */
export type Session = {id: string; expires: number; access?: string};
const MAX_SESSIONS = 16;
const SESSION_MS = 12 * 60 * 60_000;
const DESKTOP_SESSION_MS = 30 * 24 * 60 * 60_000;

/** The desktop app's key: random, created once, readable only by the owner (DATA/desktop-key). */
export function desktopKey(dataDir = DATA) {
  const file = path.join(dataDir, 'desktop-key');
  if (!existsSync(file)) writePrivate(file, randomBytes(32).toString('base64url') + '\n');
  return readFileSync(file, 'utf8').trim();
}

export class Auth {
  sessions = new Map<string, Session>();
  revokeListeners = new Set<(id: string) => void>();
  throttle: LoginThrottle;
  attemptDelayMs: number;

  /** Optional file that keeps sign-ins across restarts. It stores token hashes, never tokens. */
  store?: string;

  access?: AccessVerifier;

  constructor(options: {throttle?: LoginThrottle; attemptDelayMs?: number; store?: string; access?: AccessVerifier} = {}) {
    this.throttle = options.throttle ?? new LoginThrottle();
    this.attemptDelayMs = options.attemptDelayMs ?? 250;
    this.store = options.store;
    this.access = options.access;
    this.load();
  }

  /** Sign-ins are tied to the current password: rotating it invalidates every saved sign-in. */
  private passwordTag() {
    return createHash('sha256').update(account.hash).digest('hex').slice(0, 16);
  }

  private load() {
    if (!this.store || !existsSync(this.store)) return;
    try {
      const saved = JSON.parse(readFileSync(this.store, 'utf8'));
      if (saved.password !== this.passwordTag()) return;
      for (const session of saved.sessions ?? []) {
        if (typeof session?.id === 'string' && /^[a-f0-9]{64}$/.test(session.id) && session.expires > Date.now()) {
          this.sessions.set(session.id, {id: session.id, expires: session.expires});
        }
      }
    } catch {
      // A damaged file only means signing in again.
    }
  }

  private save() {
    if (!this.store) return;
    const saved = [...this.sessions.values()].filter(session => !session.access);
    writePrivate(this.store, JSON.stringify({password: this.passwordTag(), sessions: saved}));
  }

  async login(req: IncomingMessage, password: unknown) {
    const key = this.throttle.clientKey(req);
    this.throttle.begin(key);
    if (this.attemptDelayMs) await new Promise(resolve => setTimeout(resolve, this.attemptDelayMs));
    if (!verifyPassword(password)) throw httpError('Incorrect password', 401);
    this.throttle.succeeded(key);
    return this.issue(SESSION_MS);
  }

  /**
   * Signs in the Muster desktop app, which proves itself with the key in the data folder: it runs as the owner
   * on this computer. Its sign-in lasts 30 days, and a new one replaces the app's previous one.
   */
  async desktop(req: IncomingMessage, presented: unknown, key: string) {
    const client = this.throttle.clientKey(req);
    this.throttle.begin(client);
    if (this.attemptDelayMs) await new Promise(resolve => setTimeout(resolve, this.attemptDelayMs));
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (typeof presented !== 'string' || !key || !timingSafeEqual(digest(presented), digest(key))) {
      throw httpError('Incorrect desktop key', 401);
    }
    this.throttle.succeeded(client);
    if (this.desktopSession) this.revoke(this.desktopSession);
    const token = this.issue(DESKTOP_SESSION_MS);
    this.desktopSession = createHash('sha256').update(token).digest('hex');
    return token;
  }

  private desktopSession?: string;

  private issue(lifetime: number) {
    this.sweep();
    if (this.sessions.size >= MAX_SESSIONS) this.revoke(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    const id = createHash('sha256').update(token).digest('hex');
    this.sessions.set(id, {id, expires: Date.now() + lifetime});
    this.save();
    return token;
  }

  get(req: IncomingMessage) {
    const token = cookie(req);
    if (token) {
      const id = createHash('sha256').update(token).digest('hex');
      const session = this.sessions.get(id);
      if (session && session.expires > Date.now()) return session;
      if (session) this.revoke(id);
    }
    return this.fromAccess(req);
  }

  /** A request Cloudflare Access let through needs no app password. */
  private fromAccess(req: IncomingMessage): Session | undefined {
    const assertion = req.headers['cf-access-jwt-assertion'];
    if (!this.access || typeof assertion !== 'string') return undefined;
    const proven = this.access.verify(assertion);
    if (!proven) return undefined;
    const id = 'access:' + createHash('sha256').update(proven.subject).digest('hex').slice(0, 32);
    const known = this.sessions.get(id);
    if (known) {
      known.expires = Math.max(known.expires, proven.expires);
      return known;
    }
    const session: Session = {id, expires: proven.expires, access: proven.email};
    this.sessions.set(id, session);
    return session;
  }

  revoke(id: string) {
    if (this.sessions.delete(id)) this.save();
    for (const listener of this.revokeListeners) listener(id);
  }

  sweep() {
    for (const session of this.sessions.values()) if (session.expires < Date.now()) this.revoke(session.id);
  }
}

export const auth = new Auth({store: path.join(DATA, 'sessions.json'), access: accessFromEnv()});
setInterval(() => auth.sweep(), 30_000).unref();
