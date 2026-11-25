import {useEffect, useState} from 'react';

// Browsing module repositories and installing from them, with a consent screen that says what a module can reach.

type Api = (url: string, body?: unknown) => Promise<any>;

export type Permissions = {
  network: string[];
  connectors: string[];
  tools: string[];
  feeds: string[];
  actions: string[];
  providers: string[];
  secrets: string[];
};
export type InstallPreview = {
  token: string;
  id: string;
  name: string;
  description?: string;
  version: string;
  source: string;
  reviewed: boolean;
  permissions: Permissions;
  update: null | {from: string; added: Permissions; sourceChanged: boolean};
  dependencies: string[];
};
type Entry = {
  id: string;
  name: string;
  description: string;
  version: string;
  categories: string[];
  installed: null | {version: string};
  updateAvailable: boolean;
};
type Registry = {url: string; official: boolean; commit?: string; fetchedAt?: number; error?: string; modules: Entry[]};
export type InstallInfo = {source: string; reviewed: boolean; commit?: string; installedAt: number; previous?: string};

const SECTIONS: [keyof Permissions, string][] = [
  ['network', 'Websites it can contact'],
  ['connectors', 'Accounts it can use on this desktop'],
  ['secrets', 'Secrets it asks for'],
  ['tools', 'Tools the agent gets'],
  ['feeds', 'Inbox feeds it checks'],
  ['actions', 'Actions you can run'],
  ['providers', 'Muster features it provides'],
];
const CONNECTOR = {composio: 'Composio CLI (your linked accounts)'} as Record<string, string>;
const repoName = (url: string) => url.replace(/^https:\/\/github\.com\//, '').replace(/^https:\/\//, '');

/** What a module can reach, before it is installed. For an update, what is new is marked. */
export function Consent(props: {preview: InstallPreview; busy: boolean; install: () => void; cancel: () => void}) {
  const {preview} = props;
  const isNew = (key: keyof Permissions, item: string) => !!preview.update?.added[key].includes(item);
  const addedCount = preview.update ? Object.values(preview.update.added).reduce((n, list) => n + list.length, 0) : 0;
  return (
    <div className="module-consent">
      <header>
        <strong>
          {preview.update ? 'Update' : 'Install'} {preview.name} {preview.version}
        </strong>
        {preview.reviewed ? <span className="module-badge official">Official</span> : <span className="module-badge unreviewed">Not reviewed</span>}
      </header>
      {preview.description && <p className="muted">{preview.description}</p>}
      <small className="muted module-source">From {preview.source}</small>
      {preview.update && (
        <p className={addedCount ? 'consent-warning' : 'muted'}>
          {addedCount
            ? `Updating from ${preview.update.from}. This version can reach more than the one you have; new items are marked.`
            : `Updating from ${preview.update.from}. It asks for nothing new.`}
          {preview.update.sourceChanged && ' It comes from a different place than the installed version.'}
        </p>
      )}
      {!preview.reviewed && (
        <p className="consent-warning">
          This module is not from the official module repository. Install it only if you trust where it comes from: modules run on this
          desktop as you.
        </p>
      )}
      <dl className="consent-list">
        {SECTIONS.filter(([key]) => preview.permissions[key].length).map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              {preview.permissions[key].map(item => (
                <span key={item} className={isNew(key, item) ? 'consent-item new' : 'consent-item'}>
                  {key === 'connectors' ? CONNECTOR[item] ?? item : item}
                  {isNew(key, item) && <em>new</em>}
                </span>
              ))}
            </dd>
          </div>
        ))}
        {!!preview.dependencies.length && (
          <div>
            <dt>npm packages it installs</dt>
            <dd>
              {preview.dependencies.map(name => (
                <span key={name} className="consent-item">
                  {name}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
      <small className="muted">
        Packages install with their install scripts switched off. {preview.update ? 'Its on/off setting is kept.' : 'It starts switched off.'}
      </small>
      <div className="module-actions">
        <button onClick={props.cancel} disabled={props.busy}>
          Cancel
        </button>
        <button className="primary" onClick={props.install} disabled={props.busy}>
          {props.busy ? 'Installing…' : preview.update ? 'Update' : 'Install'}
        </button>
      </div>
    </div>
  );
}

/** The modules in each repository, with Install, Update or Installed, and installing from a link. */
export function Browse(props: {api: Api; review: (preview: InstallPreview) => void; disabled: boolean}) {
  const [data, setData] = useState<{registries: Registry[]} | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [link, setLink] = useState({git: '', path: '', ref: ''});
  const [query, setQuery] = useState('');
  const load = (refresh = false) => {
    setError('');
    return props
      .api('/modules/registry' + (refresh ? '?refresh=1' : ''))
      .then(setData)
      .catch(e => setError(e.message));
  };
  useEffect(() => {
    void load();
  }, []);
  const preview = async (key: string, body: Record<string, string>) => {
    setBusy(key);
    setError('');
    try {
      props.review(await props.api('/modules/install/preview', body));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  if (props.disabled) return <p className="muted">Installing modules is turned off on this desktop (MUSTER_MODULE_INSTALL_DISABLED).</p>;
  const q = query.trim().toLowerCase();
  return (
    <div className="module-browse">
      <div className="module-browse-bar">
        <input type="search" placeholder="Search modules" value={query} onChange={e => setQuery(e.target.value)} />
        <button className="quiet" disabled={busy === 'refresh'} onClick={() => void load(true)}>
          Refresh
        </button>
      </div>
      {!data && !error && <p className="muted">Reading the module repository…</p>}
      {data?.registries.map(registry => {
        const list = registry.modules.filter(m => !q || `${m.name} ${m.description} ${m.categories.join(' ')}`.toLowerCase().includes(q));
        return (
          <section key={registry.url} className="module-registry">
            <h3 className="module-heading">
              {repoName(registry.url)} {registry.official && <span className="module-badge official">Official</span>}
            </h3>
            {registry.error && <p className="run-error">Could not refresh: {registry.error}</p>}
            {!list.length && !registry.error && <p className="muted">{q ? 'No matching modules.' : 'No modules yet.'}</p>}
            <ul className="module-picker">
              {list.map(entry => (
                <li key={entry.id}>
                  <div className="module-entry">
                    <span className="module-picker-text">
                      <strong>
                        {entry.name} <small className="muted">{entry.version}</small>
                      </strong>
                      <small className="muted">{entry.description}</small>
                    </span>
                    {entry.installed && !entry.updateAvailable ? (
                      <span className="module-state on">Installed</span>
                    ) : (
                      <button
                        className={entry.updateAvailable ? '' : 'primary'}
                        disabled={!!busy}
                        onClick={() => void preview(registry.url + entry.id, {registry: registry.url, id: entry.id})}
                      >
                        {busy === registry.url + entry.id ? 'Checking…' : entry.updateAvailable ? `Update to ${entry.version}` : 'Install'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <details className="module-link-install">
        <summary>Install from a link</summary>
        <p className="muted">A git URL (https), optionally a branch or tag and the module's folder inside the repository, or a folder on this desktop.</p>
        <form
          onSubmit={event => {
            event.preventDefault();
            const value = link.git.trim();
            void preview('link', value.startsWith('/') ? {folder: value} : {git: value, ref: link.ref.trim(), path: link.path.trim()});
          }}
        >
          <input placeholder="https://github.com/you/your-module or /path/to/folder" value={link.git} onChange={e => setLink({...link, git: e.target.value})} />
          {!link.git.trim().startsWith('/') && (
            <div className="module-link-row">
              <input placeholder="Folder in repo (optional)" value={link.path} onChange={e => setLink({...link, path: e.target.value})} />
              <input placeholder="Branch or tag (optional)" value={link.ref} onChange={e => setLink({...link, ref: e.target.value})} />
            </div>
          )}
          <button className="primary" disabled={!link.git.trim() || !!busy}>
            {busy === 'link' ? 'Checking…' : 'Review'}
          </button>
        </form>
      </details>
      {error && <p className="run-error">{error}</p>}
    </div>
  );
}

/** Where an installed module came from, with Roll back and Remove. */
export function InstalledInfo(props: {
  api: Api;
  id: string;
  name: string;
  install?: InstallInfo;
  disabled: boolean;
  changed: (modules: any[]) => void;
  removed: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const act = async (kind: 'rollback' | 'remove') => {
    if (kind === 'remove' && !confirm(`Remove ${props.name}? Its settings and saved secrets are deleted too.`)) return;
    if (kind === 'rollback' && !confirm(`Go back to ${props.name} ${props.install?.previous}?`)) return;
    setBusy(kind);
    setError('');
    try {
      const data = await props.api(`/modules/${props.id}/${kind}`, {});
      props.changed(data.modules);
      if (kind === 'remove') props.removed();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="module-installed">
      <small className="muted">
        {props.install ? (
          <>
            {props.install.reviewed ? 'Official · ' : 'Not reviewed · '}
            from {props.install.source}, installed {new Date(props.install.installedAt).toLocaleDateString()}
          </>
        ) : (
          'Added to the modules folder by hand.'
        )}
      </small>
      {!props.disabled && (
        <div className="module-actions">
          {props.install?.previous && (
            <button disabled={!!busy} onClick={() => void act('rollback')}>
              {busy === 'rollback' ? 'Going back…' : `Roll back to ${props.install.previous}`}
            </button>
          )}
          <button className="danger-button" disabled={!!busy} onClick={() => void act('remove')}>
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        </div>
      )}
      {error && <p className="run-error">{error}</p>}
    </div>
  );
}
