// Pull-request links the assistant posted in a session. Which links count comes from the link templates that
// pull-request provider modules declare in their manifests, such as bitbucket.org /{owner}/{repo}/pull-requests/{number}.
// Templates are matched segment by segment, never as regular expressions, so a module cannot make this slow.

export type LinkTemplate = {host: string; path: string};
export type PrProvider = {module: string; links: LinkTemplate[]};
export type PrLink = {url: string; module: string; repository: string; number: string};

const PART = /^[A-Za-z0-9_.~-]{1,100}$/;
const NUMBER = /^[1-9][0-9]{0,9}$/;
const NAME = /^[a-z][A-Za-z0-9]{0,30}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const segments = (path: string) => path.split('/').filter(Boolean);
const placeholder = (segment: string) => /^\{(.+)\}$/.exec(segment)?.[1];

/** A template has an exact host, literal or {named} segments, and exactly one {number}. */
export function validTemplate(template: unknown): template is LinkTemplate {
  const t = template as LinkTemplate;
  if (!t || typeof t.host !== 'string' || typeof t.path !== 'string' || !HOST.test(t.host) || !t.path.startsWith('/')) return false;
  const parts = segments(t.path);
  if (!parts.length || parts.length > 12) return false;
  const names = parts.map(placeholder).filter((name): name is string => name !== undefined);
  if (names.filter(name => name === 'number').length !== 1 || new Set(names).size !== names.length) return false;
  return parts.every(part => {
    const name = placeholder(part);
    return name === undefined ? PART.test(part) && part !== '.' && part !== '..' : NAME.test(name);
  });
}

/** The provider and canonical link for a URL, or undefined. Extra segments after the template, a query or a fragment are dropped. */
export function matchPrLink(raw: string, providers: PrProvider[]): PrLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  let parts: string[];
  try {
    parts = segments(url.pathname).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  for (const provider of providers) {
    for (const template of provider.links) {
      if (!validTemplate(template) || url.hostname.toLowerCase() !== template.host) continue;
      const wanted = segments(template.path);
      if (parts.length < wanted.length) continue;
      const values: Record<string, string> = {};
      const ok = wanted.every((segment, index) => {
        const name = placeholder(segment);
        const value = parts[index];
        if (name === undefined) return value === segment;
        if (name === 'number' ? !NUMBER.test(value) : !PART.test(value) || value === '.' || value === '..') return false;
        values[name] = value;
        return true;
      });
      if (!ok) continue;
      const path = wanted.map(segment => {
        const name = placeholder(segment);
        return name === undefined ? segment : encodeURIComponent(values[name]);
      });
      return {
        url: `https://${template.host}/${path.join('/')}`,
        module: provider.module,
        repository: wanted.map(placeholder).filter((name): name is string => !!name && name !== 'number').map(name => values[name]).join('/'),
        number: values.number,
      };
    }
  }
  return undefined;
}

/** Links matching a provider, from assistant messages only (not the owner's messages or imported context). */
export function sessionPrLinks(messages: {role: string; content?: unknown}[], providers: PrProvider[]): PrLink[] {
  const found = new Map<string, PrLink>();
  if (!providers.length) return [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content) ? message.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : '';
    for (const match of text.matchAll(/https:\/\/[^\s<>"'`()[\]{}]+/g)) {
      const link = matchPrLink(match[0].replace(/[.,;:!?*_]+$/, ''), providers);
      if (link && !found.has(link.url)) found.set(link.url, link);
    }
  }
  return [...found.values()];
}
