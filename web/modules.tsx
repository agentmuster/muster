import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {Browse, Consent, InstalledInfo, type InstallInfo, type InstallPreview} from './module-store';

// Settings → Modules, and the Actions panel that runs module actions with a preview first.

export type Field = {
  key: string;
  label: string;
  type: 'string' | 'secret' | 'text' | 'number' | 'select';
  description?: string;
  default?: string | number;
  required?: boolean;
  options?: {value: string; label?: string}[];
  showWhen?: Record<string, string[]>;
  link?: {url: string; label: string};
};
export type ModuleInfo = {
  id: string;
  name: string;
  description?: string;
  version: string;
  enabled: boolean;
  settings: Field[];
  values: Record<string, unknown>;
  secretsSet: Record<string, boolean>;
  missing: string[];
  actions: {id: string; title: string; description?: string; confirm: string}[];
  network: string[];
  feeds?: {id: string; title: string; every: number}[];
  providers?: {pullRequests?: {links: {host: string; path: string}[]; mergeAction: string}};
  tools?: string[];
  connectors?: string[];
  install?: InstallInfo;
};
export type ModuleRun = {
  id: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  preview: {summary: string};
  progress?: {text?: string; link?: string; steps?: {name: string; state: string}[]};
  result?: {text?: string; link?: string; steps?: {name: string; state: string}[]};
  error?: string;
  started: number;
};
type Api = (url: string, body?: unknown) => Promise<any>;
type Preview = {summary: string; details?: string[]; danger?: boolean; confirmLabel?: string; link?: string; token: string};

function Modal(props: {title: string; close: () => void; children: React.ReactNode; wide?: boolean}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.close]);
  return createPortal(
    <div className="snippet-backdrop" onClick={props.close}>
      <section className={'module-modal' + (props.wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={props.title} onClick={e => e.stopPropagation()}>
        <header>
          <strong>{props.title}</strong>
          <button className="icon-button" aria-label="Close" onClick={props.close}>
            ×
          </button>
        </header>
        <div className="module-body">{props.children}</div>
      </section>
    </div>,
    document.body,
  );
}

const visible = (field: Field, values: Record<string, unknown>) =>
  !field.showWhen || Object.entries(field.showWhen).every(([key, allowed]) => allowed.includes(String(values[key] ?? '')));

/** One form field. Secrets are write-only: the saved value is never sent back to the page. */
function FieldInput(props: {field: Field; value: unknown; set: (value: unknown) => void; secretSet?: boolean}) {
  const {field} = props;
  const id = 'field-' + field.key.replace(/[^\w-]/g, '-');
  const common = {id, 'aria-describedby': field.description ? id + '-help' : undefined, 'aria-required': field.required || undefined};
  let input;
  if (field.type === 'select') {
    input = (
      <select {...common} value={String(props.value ?? '')} onChange={e => props.set(e.target.value)}>
        {!field.required || props.value === '' ? <option value="">Choose…</option> : null}
        {(field.options ?? []).map(option => (
          <option key={option.value} value={option.value}>
            {option.label ?? option.value}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'text') {
    input = <textarea {...common} rows={3} value={String(props.value ?? '')} onChange={e => props.set(e.target.value)} />;
  } else if (field.type === 'secret') {
    input = (
      <input
        {...common}
        type="password"
        autoComplete="new-password"
        placeholder={props.secretSet ? 'Saved. Type a new value to replace it.' : 'Not set'}
        value={String(props.value ?? '')}
        onChange={e => props.set(e.target.value)}
      />
    );
  } else {
    input = (
      <input
        {...common}
        type={field.type === 'number' ? 'number' : 'text'}
        value={String(props.value ?? '')}
        onChange={e => props.set(e.target.value)}
      />
    );
  }
  // The label names the field; the description is linked as help, so it is not read as the name.
  return (
    <div className="module-field">
      <label htmlFor={id}>
        {field.label}
        {field.required && (
          <i title="Required" aria-hidden="true">
            {' '}
            *
          </i>
        )}
      </label>
      {input}
      {field.description && (
        <small id={id + '-help'} className="muted">
          {field.description}
        </small>
      )}
      {field.link && /^https:\/\//.test(field.link.url) && (
        <a className="module-field-link" href={field.link.url} target="_blank" rel="noopener noreferrer">
          {field.link.label || 'Create one'} ↗
        </a>
      )}
    </div>
  );
}

/** What a module offers, in a few words, for the picker. */
function offers(module: ModuleInfo) {
  const parts = [];
  if (module.actions.length) parts.push(module.actions.length === 1 ? module.actions[0].title : `${module.actions.length} actions`);
  if (module.feeds?.length) parts.push('Inbox');
  if (module.tools?.length) parts.push('agent tools');
  if (module.providers?.pullRequests) parts.push('pull requests');
  return parts.join(' · ');
}

/** Pick a module, then see and change its settings. initial opens one module directly. */
export function ModulesSettings(props: {api: Api; close: () => void; changed: (modules: ModuleInfo[]) => void; initial?: string}) {
  const [modules, setModules] = useState<ModuleInfo[] | null>(null);
  const [picked, setPicked] = useState(props.initial ?? '');
  const [tab, setTab] = useState<'installed' | 'browse'>('installed');
  const [review, setReview] = useState<InstallPreview | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installDisabled, setInstallDisabled] = useState(false);
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState<Record<string, {values: Record<string, unknown>; secrets: Record<string, string>}>>({});
  const [status, setStatus] = useState<Record<string, string>>({});
  const load = async () => {
    const data = await props.api('/modules');
    setInstallDisabled(!!data.installDisabled);
    setModules(data.modules);
    props.changed(data.modules);
    setDrafts(Object.fromEntries(data.modules.map((m: ModuleInfo) => [m.id, {values: {...m.values}, secrets: {}}])));
  };
  useEffect(() => {
    void load().catch(error => setStatus({all: error.message}));
  }, []);
  const save = async (module: ModuleInfo, enabled = module.enabled) => {
    setStatus(s => ({...s, [module.id]: 'Saving…'}));
    // The switch moves at once; a failed save puts it back.
    setModules(list => list?.map(m => (m.id === module.id ? {...m, enabled} : m)) ?? list);
    try {
      const draft = drafts[module.id];
      const data = await props.api(`/modules/${module.id}/settings`, {enabled, values: draft.values, secrets: draft.secrets});
      setModules(data.modules);
      props.changed(data.modules);
      setDrafts(d => ({...d, [module.id]: {values: {...draft.values}, secrets: {}}}));
      setStatus(s => ({...s, [module.id]: 'Saved'}));
    } catch (error: any) {
      setModules(list => list?.map(m => (m.id === module.id ? {...m, enabled: module.enabled} : m)) ?? list);
      setStatus(s => ({...s, [module.id]: error.message}));
    }
  };
  const replaced = (list: ModuleInfo[]) => {
    setModules(list);
    props.changed(list);
    setDrafts(d => ({...Object.fromEntries(list.map(m => [m.id, {values: {...m.values}, secrets: {}}])), ...d}));
  };
  const install = async () => {
    if (!review) return;
    setInstalling(true);
    try {
      const data = await props.api('/modules/install', {token: review.token});
      replaced(data.modules);
      setDrafts(d => ({...d, [data.id]: {values: {...(data.modules.find((m: ModuleInfo) => m.id === data.id)?.values ?? {})}, secrets: {}}}));
      setReview(null);
      setNotice(data.updated ? `Updated to ${data.version}.` : 'Installed. Fill in its settings, then turn it on.');
      setTab('installed');
      setPicked(data.id);
    } catch (error: any) {
      setStatus(s => ({...s, all: error.message}));
      setReview(null);
    } finally {
      setInstalling(false);
    }
  };
  const chosen = modules?.find(module => module.id === picked);
  return (
    <Modal title={review ? 'Review module' : chosen ? chosen.name : 'Modules'} close={props.close} wide>
      {status.all && <p className="run-error">{status.all}</p>}
      {!modules ? (
        <p className="muted">Loading…</p>
      ) : review ? (
        <Consent preview={review} busy={installing} install={() => void install()} cancel={() => setReview(null)} />
      ) : !chosen ? (
        <>
          <div className="files-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'installed'} className={tab === 'installed' ? 'active' : ''} onClick={() => setTab('installed')}>
              Installed <span>{modules.length}</span>
            </button>
            <button role="tab" aria-selected={tab === 'browse'} className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>
              Browse
            </button>
          </div>
          {tab === 'browse' ? (
            <Browse
              api={props.api}
              disabled={installDisabled}
              review={preview => {
                setStatus(s => ({...s, all: ''}));
                setReview(preview);
              }}
            />
          ) : !modules.length ? (
            <p className="muted">
              No modules yet. Modules connect other services, such as Teams, Bitbucket deploys and pull requests.{' '}
              <button className="quiet" onClick={() => setTab('browse')}>
                Browse modules
              </button>
            </p>
          ) : (
          <>
          <p className="muted">Modules connect other services. Pick one to turn it on or change its settings.</p>
          <ul className="module-picker">
            {modules.map(module => (
              <li key={module.id}>
                <button onClick={() => setPicked(module.id)}>
                  <span className="module-picker-text">
                    <strong>{module.name}</strong>
                    <small className="muted">{offers(module) || module.description}</small>
                  </span>
                  <span
                    className={
                      'module-state ' + (!module.enabled ? 'off' : module.missing.length ? 'setup' : 'on')
                    }
                  >
                    {!module.enabled ? 'Off' : module.missing.length ? 'Needs setup' : 'On'}
                  </span>
                  <span className="module-chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
          </>
          )}
        </>
      ) : (
        [chosen].map(module => {
          const draft = drafts[module.id] ?? {values: {}, secrets: {}};
          return (
            <section key={module.id} className={'module-card' + (module.enabled ? ' on' : '')}>
              <button
                className="quiet module-back"
                onClick={() => {
                  setPicked('');
                  setNotice('');
                }}
              >
                ← All modules
              </button>
              {notice && <p className="module-notice">{notice}</p>}
              <header>
                <div>
                  <strong>{module.name}</strong>
                  <small className="muted">
                    {module.version} · can contact {module.network.join(', ') || 'nothing'}
                    {module.connectors?.includes('composio') ? ' · through the Composio CLI' : ''}
                    {module.feeds?.length ? ` · Inbox: checks ${module.feeds.map(f => f.title).join(', ')} every ${module.feeds[0].every} min` : ''}
                    {module.tools?.length ? ` · agent tools: ${module.tools.join(', ')}` : ''}
                  </small>
                </div>
                <label className="check module-toggle">
                  <input type="checkbox" checked={module.enabled} onChange={e => void save(module, e.target.checked)} />
                  {module.enabled ? 'On' : 'Off'}
                </label>
              </header>
              {module.description && <p className="muted">{module.description}</p>}
              {module.settings.map(field => (
                <FieldInput
                  key={field.key}
                  field={field}
                  secretSet={module.secretsSet[field.key]}
                  value={field.type === 'secret' ? draft.secrets[field.key] ?? '' : draft.values[field.key]}
                  set={value =>
                    setDrafts(d => ({
                      ...d,
                      [module.id]:
                        field.type === 'secret'
                          ? {...draft, secrets: {...draft.secrets, [field.key]: String(value)}}
                          : {...draft, values: {...draft.values, [field.key]: value}},
                    }))
                  }
                />
              ))}
              <div className="module-actions">
                <button className="primary" onClick={() => void save(module)}>
                  Save
                </button>
                <span className="muted">{status[module.id] || (module.missing.length ? 'Needs: ' + module.missing.join(', ') : '')}</span>
              </div>
              <InstalledInfo
                api={props.api}
                id={module.id}
                name={module.name}
                install={module.install}
                disabled={installDisabled}
                changed={replaced}
                removed={() => setPicked('')}
              />
            </section>
          );
        })
      )}
    </Modal>
  );
}

const ICON: Record<string, string> = {succeeded: '✓', failed: '✕', running: '…'};

function RunView(props: {run: ModuleRun}) {
  const {run} = props;
  const view = run.result ?? run.progress ?? {};
  return (
    <div className={'module-run ' + run.status}>
      <strong>
        {ICON[run.status]} {run.title}
      </strong>
      <small className="muted">{run.preview.summary}</small>
      {view.text && <p>{view.text}</p>}
      {run.error && <p className="run-error">{run.error}</p>}
      {!!view.steps?.length && (
        <ol className="module-steps">
          {view.steps.map((step, index) => (
            <li key={index} className={step.state.replace(/\s+/g, '-')}>
              <span>{step.name}</span>
              <small>{step.state}</small>
            </li>
          ))}
        </ol>
      )}
      {view.link && (
        <a href={view.link} target="_blank" rel="noopener">
          Open in the service
        </a>
      )}
    </div>
  );
}

/** Pick an action, fill it in, check the preview, confirm, then follow its progress. */
export function ActionsPanel(props: {api: Api; modules: ModuleInfo[]; close: () => void; openSettings: () => void; openTerminal: () => void}) {
  const actions = props.modules
    .filter(module => module.enabled)
    .flatMap(module => module.actions.map(action => ({module, action})));
  const [chosen, setChosen] = useState<(typeof actions)[number] | null>(null);
  const [fields, setFields] = useState<Field[] | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [run, setRun] = useState<ModuleRun | null>(null);
  const [recent, setRecent] = useState<ModuleRun[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void props.api('/modules').then(data => setRecent(data.runs)).catch(() => {});
  }, []);

  // Follow a run until it finishes.
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const timer = setInterval(() => {
      void props.api('/modules/runs/' + run.id).then(setRun).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [run?.id, run?.status]);

  const choose = async (choice: (typeof actions)[number]) => {
    setChosen(choice);
    setFields(null);
    setPreview(null);
    setRun(null);
    setError('');
    setBusy('Loading…');
    try {
      const {fields} = await props.api(`/modules/${choice.module.id}/actions/${choice.action.id}/fields`, {});
      setFields(fields);
      setValues(Object.fromEntries(fields.map((f: Field) => [f.key, f.default ?? (f.type === 'select' && f.required ? f.options?.[0]?.value ?? '' : '')])));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const input = () => Object.fromEntries((fields ?? []).filter(f => visible(f, values)).map(f => [f.key, values[f.key] ?? '']));
  const doPreview = async () => {
    if (!chosen) return;
    setError('');
    setBusy('Checking…');
    try {
      setPreview(await props.api(`/modules/${chosen.module.id}/actions/${chosen.action.id}/preview`, {input: input()}));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };
  const confirm = async () => {
    if (!chosen || !preview) return;
    setError('');
    setBusy('Starting…');
    try {
      setRun(await props.api(`/modules/${chosen.module.id}/actions/${chosen.action.id}/run`, {input: input(), token: preview.token}));
      setPreview(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal title={chosen ? `${chosen.module.name}: ${chosen.action.title}` : 'Actions'} close={props.close}>
      {!chosen ? (
        <>
          <ul className="module-action-list">
            <li>
              <button onClick={props.openTerminal}>
                <strong>Terminal</strong>
                <small className="muted">A shell on this desktop, in the browser</small>
              </button>
            </li>
          </ul>
          {actions.length ? (
            <ul className="module-action-list">
              {actions.map(choice => (
                <li key={choice.module.id + choice.action.id}>
                  <button onClick={() => void choose(choice)}>
                    <strong>{choice.action.title}</strong>
                    <small className="muted">
                      {choice.module.name}
                      {choice.action.description ? ' · ' + choice.action.description : ''}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Modules add more actions, such as deploys. Turn one on in Module settings.</p>
          )}
          <button className="quiet" onClick={props.openSettings}>
            Module settings
          </button>
          {recent.length > 0 && (
            <>
              <h3 className="module-heading">Recent runs</h3>
              {recent.slice(0, 5).map(item => (
                <RunView key={item.id} run={item} />
              ))}
            </>
          )}
        </>
      ) : run ? (
        <>
          <RunView run={run} />
          {run.status !== 'running' && (
            <button className="quiet" onClick={() => setChosen(null)}>
              Back to actions
            </button>
          )}
        </>
      ) : preview ? (
        <div className={'module-preview' + (preview.danger ? ' danger' : '')}>
          {preview.danger && <span className="module-danger-tag">Affects production</span>}
          <strong>{preview.summary}</strong>
          <ul>
            {(preview.details ?? []).map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
          {preview.link && (
            <a href={preview.link} target="_blank" rel="noopener">
              Open in the service
            </a>
          )}
          <div className="module-actions">
            <button onClick={() => setPreview(null)}>Back</button>
            <button className={preview.danger ? 'danger-button' : 'primary'} disabled={!!busy} onClick={() => void confirm()}>
              {busy || preview.confirmLabel || 'Run'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {!fields ? (
            error ? (
              // The action cannot load, usually because a setting is missing: offer the way to fix it.
              <div className="module-actions">
                <button type="button" onClick={() => setChosen(null)}>
                  Back
                </button>
                <button type="button" className="primary" onClick={props.openSettings}>
                  Open module settings
                </button>
              </div>
            ) : (
              <p className="muted">{busy || 'Loading…'}</p>
            )
          ) : (
            <form
              onSubmit={event => {
                event.preventDefault();
                void doPreview();
              }}
            >
              {fields.filter(f => visible(f, values)).map(field => (
                <FieldInput key={field.key} field={field} value={values[field.key]} set={value => setValues(v => ({...v, [field.key]: value}))} />
              ))}
              <div className="module-actions">
                <button type="button" onClick={() => setChosen(null)}>
                  Back
                </button>
                <button className="primary" disabled={!!busy}>
                  {busy || 'Preview'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {error && <p className="run-error">{error}</p>}
    </Modal>
  );
}
