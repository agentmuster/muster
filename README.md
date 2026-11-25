# Muster

One app for all your AI agents and their sessions. Muster runs on an always-on desktop and you use it from anywhere, including your phone. Search your Pi, Claude Code and Codex history, continue or split any session, run managed Pi threads with cited context, and take over the desktop's BrowserOS browser when an agent needs you.

Website: [agentmuster.io](https://agentmuster.io). Modules for other services are in [muster-modules](https://github.com/agentmuster/muster-modules).

The frontend uses CopilotKit. Its runtime and the session index run locally. Model requests still go to the provider configured in your installed Pi account. Selected historical excerpts travel with those requests. Nothing sends the full index to an embedding or hosted CopilotKit service.

## Run locally

Requires macOS (Linux is untested), Node 22.23 or later, Python 3 with NumPy and scikit-learn, and the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) CLI signed in to a model provider. [BrowserOS](https://www.browseros.com) is optional: without it, browser takeover and the agent's browser tool are unavailable, and everything else works.

```sh
npm install
python3 -m pip install -r requirements.txt
cp .env.example .env
npm run index
npm run build
npm start
```

Open `http://127.0.0.1:47831`. The server binds only to loopback. On first startup it creates a random owner password and saves it in a private local file:

```sh
cat ~/.local/share/muster/initial-password.txt
```

Enter that password in the app's sign-in form. Do not put it in a URL, chat message, tunnel command, or source control. The file is kept so you can sign in from another device; the account itself stores only a scrypt hash. Once you have saved the password somewhere safer, you can delete the file.

To replace the password, run `npm run rotate-password`, then restart the app. The script writes a new hash and a new `initial-password.txt` (mode 600). Sign-ins live in server memory, so the restart signs out every device.

`MUSTER_WORKSPACE_ROOTS` limits which working directories a new thread can select. Its default is the owner's home directory. Narrow it to your project directories before enabling remote access. This controls directory selection, not the agent's filesystem permissions.

## Use it

Describe the task, project or ticket on the start screen and choose **Find sessions**. A short Pi run (your default model, low thinking) searches the local index with its own tools: `search_sessions`, `recent_sessions` and `read_session`. It tries several phrasings, opens the strongest candidates, and reports up to five sessions with why each fits, where the work left off, and a recommended action. The progress list shows each search as it happens. Excerpts it reads go to your model provider; the index stays on the desktop. The tools only read the index, and the finder run has no shell or file access.

Each result offers three actions:

- **Continue** resumes that Pi session file in place; new messages are appended to the original. The app refuses a second Continue on the same file, and warns when the file changed in the last five minutes because it may be open in a terminal Pi.
- **Split** forks a Pi session with `pi --fork <file> --session-id <id>` into your normal Pi session folder, so `/resume` in a terminal finds it too. Claude Code and Codex sessions cannot be opened by Pi, so Split brings their conversation in as cited context and shows it in the chat.
- **New with context** starts a fresh thread that retrieves excerpts from that session on the first message.

Continue and Split show the earlier conversation in the chat and use the session's working directory when it is inside your workspace roots. Every run names its model (the picker's choice or your Pi default), so a resumed session does not fall back to a model it last used. The request you typed is put in the chat box, ready to edit and send.

Start a thread, pick its working directory, and describe a ticket or task. Before the first Pi run, the server searches all three session stores and picks up to three earlier sessions. A session that mentions the exact ticket always wins. Otherwise it takes sessions scoring within 15% of the best match, and nothing at all when the best match is weak. Expand the context section to inspect the excerpts, file paths, line numbers, and branch references that were sent. You can also select up to six sources manually in the history sidebar. If retrieval fails, the next message retries it.

Pasting more than about 30 lines or 2,000 characters into the message box adds it as a **Pasted text** chip instead of filling the box; tap the chip to preview it or × to drop it. When sent, each paste goes to the agent as a fenced block marked `pasted`, longer than any backtick run inside it. In the conversation, pasted blocks and any message over 40 lines or 4,000 characters show as a card with the first lines and the size. **Show all** opens the full text with a Copy button. Thread titles name a paste as "[pasted text]" instead of quoting it.

The microphone beside the paperclip starts browser voice typing. Allow speech or microphone access when prompted, speak, then tap it again to stop. Final words append to your draft; partial words appear below the box. Review the text before sending or queuing it. Muster does not record or upload audio and needs no API key, but your browser's speech service may send audio to its provider. Language follows your browser settings. Where Web Speech isn't supported, use your keyboard's microphone. Dictation stops when you hide the page or leave the thread.

The **Thinking** and **Tool calls** checkboxes above the chat show Pi's reasoning and each tool call with its arguments and output. Both are off by default. Each browser remembers its own choices, along with the working directory and the automatic-search setting. Images a tool returns, such as a picture the agent reads or a browser screenshot, show as thumbnails under the tool call; tap one for full screen. They are saved privately in `uploads/` in the data folder and need sign-in to view, up to four per tool call and 10 MB each. Thinking is capped at 20,000 characters per block, tool arguments at 4,000 and tool output at 6,000, and tool output is redacted for common secret formats before it is saved.

Search combines three signals. SQLite FTS5 keyword matching is scored per query, relative to the best chunk, and weighted by how many of your search terms a session contains. A local TF-IDF/LSA model adds related-area matches; this is latent semantic search, not a neural embedding model. Recent sessions get a small boost. Ticket keys such as `PROJ-100` and issue references such as `#1234` get a separate exact lookup across every chunk, so a match is found however many other sessions mention the same numbers. If the semantic model can't load, the sidebar says so and keyword and ticket search keep working.

The index reads originals without modifying them. A refresh skips files whose modification time and size have not changed. Refresh the index from the sidebar after other agents save new work. A full rebuild of about 850 sessions takes about a minute.

A source preview shows recent indexed excerpts. Search and automatic context selection can find older matching excerpts too. The index includes alternate Pi branches and marks Claude subagent conversations. Historical decisions are evidence, not a claim about the current branch or repository state.

The parser indexes user and assistant text and summaries. It skips system prompts, thinking, tool output, and images, plus text that harnesses inject into the user turn, such as `<environment_context>`, `<system-reminder>`, IDE file notices, and slash-command output. For Codex it uses the prompt you typed rather than the copy wrapped in injected context. Titles come from a Pi session name or the first prompt you typed. Malformed, incomplete, and oversized records are skipped, and each message is capped at 32,000 characters.

Redaction covers API keys and passwords in `KEY=value` and JSON form, `sk-`, GitHub, Slack, Google and AWS keys, JWTs, PEM private keys, Bearer and Basic credentials, and passwords inside URLs. It applies to titles and working directories as well as message text, and to Pi error output shown in the app. Redaction is best-effort. Treat the index as private transcript data.

All three histories are searchable. This version executes through Pi only. It resumes app-managed Pi threads, not the original Claude Code, Codex, or Pi source files. A new thread with selected context is the supported way to reuse those originals.

In the thread list a running thread has a blinking green dot. A thread waiting on you is highlighted with the reason: **Reply ready** (it finished since you last had it open), **Needs your help in the browser** (the agent asked for a sign-in or other help), **Stopped** (the run failed or was interrupted, not when you stopped it) or **Queued messages are on hold**. The count shows on the Threads tab, on the ☰ button on a phone, and in the browser tab's title. When a thread you are not looking at starts waiting, a notice appears that opens it. **Turn on notifications** in the ⋮ menu adds system notifications while the tab is in the background; on iPhone that needs Muster added to the Home Screen, and the page has to be open in the background. Opening a thread marks it seen on every device.

Jobs continue when the browser tab disconnects. An open thread follows every later run on it, and reconnecting shows the saved output of the latest run. Each thread runs one job at a time, and threads in the same folder run side by side. Messages sent while a thread is busy wait in a queue above the message box, saved on the server, and run in order when the reply finishes; ⚡ sends one into the running reply instead. A failed, stopped or interrupted run holds the queue until you resume it. Provider errors and context overflows are left to Pi's own retry and compaction; a run fails only when Pi gives up. Live output stops streaming after 120,000 characters, but the run continues and its final message is saved.

Type **/** in the message box for the thread's commands: extension commands such as `/workflows` or `/code-review`, prompt templates, and skills as `/skill:name`, each with its description. Arrow keys and Enter (or a tap) pick one; Escape closes the list. Muster asks the thread's Pi for them (`get_commands`), so project prompts and skills in the thread's folder are included, and caches the list per folder for ten minutes. Pi runs the command when the message is sent.

When the agent or an extension asks you something through Pi's dialogs, such as the `ask_user_question` tool or a confirmation, the question appears as a card above the message box and the run waits for you: tap an option, Yes or No, or type an answer. **Skip this question** sends Pi a cancellation. The thread list and notifications show "Has a question for you" meanwhile. A question that Pi gave a time limit disappears when Pi answers it with its default.

Subagents and workflows the agent starts **in the background** keep working after its reply. Muster normally ends Pi when a reply settles, but if that Pi's session still has async subagents (from pi-subagents' run records) or background workflows (from pi-dynamic-workflows' run records) running, Muster keeps it alive. When the work finishes, Pi reports back by itself: the "Background task completed" message and the agent's answer stream into the thread as a new reply, the same way a queued message does. A message you send meanwhile goes to that same Pi, switching model or thinking level if you changed them. Pi ends 30 seconds after the last background run finishes, or after six hours at most. The thread header shows a count while anything runs, a strip above the message box names what is running, and either opens a panel listing each subagent and workflow with its task, phase, progress, time, tokens and cost; tapping one shows the end of its output, refreshed every few seconds. **Stop** in the panel ends the Pi and its background work. The idle-restart watcher waits for background work too. 

The context ring in a thread's header shows how full the model's context window is. Its panel has an **Auto-compact at** slider: Pi normally compacts just before the window is full, and the slider moves that point earlier, for example to 500k on a 1M model. Muster saves it in `~/.pi/agent/settings.json` as `compaction.modelOverrides["provider/model"].reserveTokens`, so it applies to that model in every thread and in Pi itself, from the next message. Dragging to the far right, or **Reset to Pi default**, removes the override. A folder's own `.pi/settings.json` wins over it, and the slider says so.

The latest reply has two buttons. Copy copies its text. Retry (the circular arrows) asks for confirmation, then sends your last message again on a Pi branch that leaves out the reply: Pi forks the session file from just before that message, the thread continues on the fork, and the original file keeps the abandoned reply. Commands the agent ran and files it changed are not undone. If the branch can't be made, the conversation is left as it was.

When the server restarts, it marks active jobs as interrupted. If a job's Pi process is still running, the server stops it and its child processes, and the job status says so. Resume the conversation explicitly.

Managed threads run your normal Pi setup: the extensions and packages in `~/.pi/agent/settings.json` (subagents, workflows, MCP, mempalace, goals), skills, prompt templates and `AGENTS.md` context files. The app adds its `browseros` tool and passes `--mcp-config` with a private copy of the Pi MCP layer that sets `disabled: true` on every BrowserOS MCP server, so browser work goes through the tool that respects takeover. Other MCP servers stay enabled. Extension dialogs (select, confirm, input, editor) are dismissed automatically because no one is at a terminal.

The model comes from your Pi defaults unless you pick one in the thread's ⋯ menu. The model and thinking level you choose are saved per device and apply to the next message; the server only accepts models listed by `pi --list-models`.

## Files from the desktop

Files the agent writes or edits in a thread are listed in its **Files** panel, the document button in the thread header. For files made any other way, such as a script's output, a converted PDF or an archive, the agent calls its `share_file` tool. Paths of listed files in chat messages become links that open the file.

The panel has two sections. **Code changes** lists files the agent edited, plus new source and config files, with lines added and removed. **Artifacts** lists reports, notes, exports, images and anything shared with `share_file`. Just before the agent first writes or edits a file in a thread, the app's Pi extension saves the file as it was, so opening a changed file shows a color-coded diff (diff2html with highlight.js) of everything the thread changed, with a **Whole file** option and a **File** tab for the current version. When that saved copy is missing, the app undoes the patch Pi's edit tool reports to recover the earlier version. Files over 1 MB and binary files get no diff. Earlier versions are kept in `baselines/` in the data folder.

The panel previews images, video, audio, PDFs, Markdown and text, and shows HTML in a sandbox that can run scripts but cannot read the app's cookies or call its API. Every file has Open and Download buttons, and × removes it from the list without deleting it.

The server only serves files listed in that thread, and checks each one again on every request. A file must be inside the thread's folder or `/tmp`, at most 200 MB, and an ordinary file after following links. It must not be credential or key material (`.env`, `.ssh`, `.aws`, Pi, Claude and Codex auth files, keychains, `*.pem`, `*.key`, `id_*`, names containing secret, credential or password) or the app's own data folder.

## Terminal

The **>_** button in the header (or **Ctrl+`** on a desktop, or **⚡ Actions → Terminal**) opens a shell on the desktop in the browser. It goes straight to your newest shell, or starts one if none is running; turning the terminal on opens the first shell right away. It runs xterm.js over a WebSocket to a pseudo-terminal from `node-pty`. It is off until you turn it on, with a confirmation; `MUSTER_TERMINAL_DISABLED=1` keeps it off whatever the setting. Once on, anyone who can sign in to Muster can run any command on the desktop as you, so keep remote access behind Cloudflare Access or an equivalent.

Each terminal runs your login shell (`$SHELL -l`) in a workspace folder, with Muster's own `MUSTER_*` settings removed from its environment. Connections need a signed-in session and pass the same Host and Origin checks as the browser viewer. Signing out or an expired sign-in closes the connection; the shell keeps running, so you can reattach and see its recent output (the last 256 KB). Up to four terminals can be open, and one nobody has attached to for 30 minutes is closed. Turning the terminal off closes them all. `logs/terminal.jsonl` in the data folder records when terminals start, attach and end, never what is typed.

On a phone, a key bar adds Ctrl (applies to the next key), Esc, Tab, the arrows, ^C and a few symbols that phone keyboards hide, and the terminal stays above the on-screen keyboard.

## Modules

Modules connect Muster to other services. A module can add:

- **actions** you run from **⚡ Actions**, such as a deploy, always with a preview and your confirmation first;
- **Inbox feeds**, such as Teams messages meant for you;
- **tools** the agent can call while it works, such as searching Teams;
- **providers** for Muster features, such as reviewing and merging pull requests.

Muster ships with no modules. Install them from **⋮ → Modules → Browse**, which lists the modules in [muster-modules](https://github.com/agentmuster/muster-modules): Bitbucket Pipelines, Bitbucket pull requests and Microsoft Teams so far. Muster fetches that repository with git, using the git credentials on the desktop, so a private repository works too. To list other module repositories, set `MUSTER_MODULE_REGISTRIES` to their git URLs, separated by commas.

**Install** fetches the module and shows what it can reach before anything is installed:

- the websites it can contact;
- accounts on this desktop it can use, such as the Composio CLI;
- the secrets it asks for;
- the agent tools, Inbox feeds, actions and Muster features it adds;
- any npm packages it installs.

Modules from the official repository are marked **Official**; anything else is marked **Not reviewed**. After you confirm, Muster checks that the staged files haven't changed since you saw them, then installs the module's npm dependencies with install scripts switched off, so no third-party code runs during install. It moves the module into `~/.config/muster/modules/<id>` (or `MUSTER_MODULES_DIR`), switched off, and records its source, commit and a hash of its files in `modules/modules.lock.json` in the data folder.

An update is shown in Browse when the repository has a newer version, and it asks only for what's new. Your settings and on/off state are kept, and the previous version stays for **Roll back**. **Remove** deletes the module with its settings and saved secrets. **Install from a link** takes a git URL (https, with an optional folder and branch or tag) or a folder on the desktop. Setting `MUSTER_MODULE_INSTALL_DISABLED=1` turns installing, updating and removing off. Installing from the app runs new code as you, the same trust as the terminal, so keep remote access behind strong sign-in.

The same works from a terminal:

```sh
node bin/agentmuster.mjs module browse
node bin/agentmuster.mjs module add microsoft-teams
node bin/agentmuster.mjs module update microsoft-teams
node bin/agentmuster.mjs module rollback microsoft-teams
node bin/agentmuster.mjs module remove microsoft-teams
node bin/agentmuster.mjs module add --git https://github.com/you/your-module --ref v1.0.0
```

A running Muster picks up those changes the next time the module list is read.

### How modules run

Each call runs in its own process with a small environment: no Muster credentials, Pi settings or tokens. A module reads its settings from a context object and may contact only the hosts in its manifest's `network` list and in URLs in its own settings, over https (http only on loopback). Secret settings are write-only in the form, stored in `modules/secrets.json` (mode 600, not encrypted at rest) and never sent to the page or the agent. Modules are code you choose to run on your desktop, like Pi extensions: these limits prevent accidents, not a module written to do harm.

**Actions** take three steps: fill in the form, read the preview, confirm. An action runs only with the token of a preview of exactly those inputs, shown in the last ten minutes, and each token works once. Muster enforces this, not the module. Every run is logged in `modules/activity.jsonl`.

**Inbox feeds** are checked on their own schedule; Muster keeps the latest 500 items in `modules/inbox.json`. New messages go to your default Pi model, together with the open requests, and come back grouped into **requests**: what someone needs you to do or answer, with a title, a short summary, who's asking and a priority. A follow-up joins the request it continues. Messages that ask nothing of you (thanks, updates, FYIs, small talk) are kept under **Other messages**. **Start session** on a request opens a thread with the ask and its messages in the message box; **✓** marks it done.

**Agent tools** of enabled modules are offered to every managed thread from its next message. Each call goes through Muster's loopback-only internal API with the thread's capability token, and long output is trimmed to 40,000 characters. Calls are logged with their inputs, not their results. Tools should only read; anything that changes something belongs in an action.

**Pull-request providers** declare link templates, such as `bitbucket.org` and `/{owner}/{repo}/pull-requests/{number}`. Links the assistant posts that match one appear in the session's **Files → Pull requests** tab. Muster owns the review: **Review diff** shows the provider's snapshot file by file, and **I've reviewed this diff** records your sign-off against the exact source commit, target commit and diff, which Muster fingerprints itself. The provider's merge action must carry the `reviewed-pr` policy, so Muster refuses its preview and its run, from any screen, unless you reviewed that exact revision and the PR belongs to that module. A push after your review means reviewing again.

A module that lists `"connectors": ["composio"]` gets `ctx.composio(url, {toolkit})`, which calls an app's API through the Composio CLI signed in on this desktop, so no token passes through Muster. The URL's host must still be in the module's `network` list.

### Writing a module

Start from `templates/hello-world` in the modules repository. A module is a folder with `muster-module.json` and an entry file that imports `@agentmuster/module-sdk`:

```ts
import {defineModule} from '@agentmuster/module-sdk';

export default defineModule({
  actions: {
    'my-action': {
      fields: ctx => [/* optional form fields, possibly from live data */],
      preview: async (ctx, input) => ({summary: 'What will happen', details: ['…'], danger: false}),
      run: async (ctx, input, progress) => ({text: 'Done'}),
    },
  },
});
```

The SDK lives in `packages/module-sdk`: types, `defineModule`, `prFingerprint`, a JSON Schema for the manifest, and `@agentmuster/module-sdk/testing`, a fake context for tests. Muster links its own copy into the modules folder, so a module never bundles it. Entry files can be TypeScript.

## Browser takeover

Open BrowserOS in the app, then select a tab in the embedded viewer. No tab streams until you select it. You can click, scroll, type, navigate, or open a new tab in the desktop browser's existing profile. Shift and Alt combine with navigation keys, and Cmd/Ctrl+A, C, X, Z and Shift+Z are sent as the browser's select-all, copy, cut, undo and redo commands. Copy and cut use the desktop's clipboard. Pasting sends your device's clipboard as text. Mobile users can focus a page field and use the masked text input below the view. That input sends text directly to the browser bridge, not through the model or chat logs.

Taking control blocks the app's browser tools and sends SIGSTOP to each managed Pi process and every process group descended from it. That includes commands Pi's bash tool starts in their own process group. A login request from Pi also pauses the run. The viewer does not record frames or input. Closing the viewer, losing your connection, signing out, or letting a sign-in expire leaves the agent paused. Use **Return control to agent** when you have finished. The paused state survives a server restart.

The pause has limits. A process that fully detaches and is adopted by launchd is no longer a descendant, so it keeps running. Any local process can also connect to BrowserOS's unauthenticated debugging port on 9110 and read what you type. The app can't pause unrelated agents already using BrowserOS, so avoid running those during credential entry. The app is not a sandbox against a malicious agent or a hostile local process.

Page dialogs (alert, confirm, prompt and "Leave site?") freeze a tab until someone answers them, and the viewer can't show them as part of the picture. The app listens for them on every tab the agent or the viewer touches. The viewer shows an open dialog with its buttons, and the agent's browser tool reports it and can answer it with its `dialog` action. The agent is told to accept confirmations that delete, send, pay or publish only when you asked for exactly that, and to ask you otherwise. Chrome only lets a debugger answer dialogs it was listening for when they opened, so a dialog that opened earlier (for example from a click at the desktop) can only be answered at the desktop. For such a tab the viewer says so and offers **Close tab**.

Choosing a tab brings it to the front of its BrowserOS window, because background tabs draw no picture and never finish handling a scroll. Scrolls are combined on your device and sent about twenty times a second without waiting behind other input. If the page falls behind, extra input is dropped instead of closing the viewer. A dropped connection reconnects on its own, keeps the last picture meanwhile, and reopens the same tab.

This is a page-only BrowserOS view. Browser chrome, native OS prompts, Touch ID, and hardware security-key dialogs are not streamed. Some passkey flows need a different sign-in method or physical access. Popups appear as other tabs; refresh the tab list and select the new one.

BrowserOS CDP stays local. The public app exposes only authenticated, validated viewer operations, never the raw debugging socket. The agent's browser tool talks to a second listener on a random loopback port. That listener accepts only direct loopback requests addressed to its own port, rejects proxied requests, and needs a per-run token.

## Install as an app

Muster is a Progressive Web App. On iPhone, open it in Safari, tap Share, then **Add to Home Screen**; it opens full screen with its own icon. Chrome and Edge on a desktop offer **Install** in the address bar. The service worker only adds an offline page shown when the desktop can't be reached; pages, the API and chat streams always go to the network and nothing private is cached. The manifest is fetched with cookies so Cloudflare Access lets it through.

The icon shows agents converging on one point, the meaning of *muster*: arrows in the colors of different AI providers gather on Muster's lime dot. It uses colors only, no logos. It was generated with `scripts/make-icons.mjs` from `scripts/icon-prompts/muster-color-dark.txt`. The script picks the newest `gpt-image` model available to the key, writes candidates to `scripts/.icon-candidates/`, and builds every size (`pick N`): 512 and 192 for the manifest, a maskable 512 with extra margin for Android, the 180 Apple touch icon, and 48/32/16 favicons cropped closer to the symbol. The full-size source is `scripts/icon-source-1024.png`.

## Remote access

Muster listens only on `127.0.0.1`. To use it from your phone or another computer, put an authenticated proxy in front of it. Don't expose the port directly.

**Cloudflare Tunnel and Cloudflare Access** is one tested setup:

1. Create a named tunnel with `cloudflared` that routes one hostname, such as `muster.example.com`, to `http://127.0.0.1:47831`.
2. In Cloudflare Zero Trust, add an Access application for that hostname that allows only your email.
3. Add the hostname to `$MUSTER_DATA_DIR/allowed-hosts`, one per line. Muster re-reads that file when it changes.
4. Set `MUSTER_TRUST_CF_CONNECTING_IP=1` in `.env`, so sign-in throttling counts each visitor separately.
5. Optionally set `MUSTER_ACCESS_TEAM`, `MUSTER_ACCESS_AUD` and `MUSTER_ACCESS_EMAILS`. A request with a valid Access token for one of those emails then signs in without the app password.

**Tailscale** or another private network works too. Add the address you'll use to `allowed-hosts`.

Either way, Muster's own sign-in still applies, and anyone who gets past both can act as you on that computer (see `SECURITY.md`).

To start Muster at login on macOS, adapt `ops/muster.plist.example` to your paths and copy it to `~/Library/LaunchAgents`.

## Files and limits

Private state defaults to `~/.local/share/muster` (set `MUSTER_DATA_DIR` to move it), with directory mode 700 and application state files mode 600. It contains the search database, local semantic model, login files, allowed hosts, browser pause state, managed threads, bounded display events, and native Pi transcripts. These files are not encrypted at rest. Keep FileVault and your desktop account protections enabled.

The display keeps a bounded recent transcript and event replay. Pi's managed JSONL transcript retains its full native context. Sign-ins last 12 hours, with at most 16 active. Each sign-in attempt waits 250 ms. A client gets eight attempts per 15 minutes, and all clients together get 200 failed attempts before sign-in pauses for everyone. Request bodies are capped at 512 KB, viewer messages at 8 KB, and Pi protocol records at about 4 MB. Larger Pi records are skipped; the app never reads them.

If the indexer is killed, the sidebar shows it as interrupted rather than running. Its last error is kept in `index-status.json`.

```sh
npm test
npm run typecheck
npm run build
npm audit
# Optional live checks against the running app:
npm run smoke:pi
npm run smoke:browser
```

The Pi smoke check makes one small model request using the installed account and leaves a saved test thread. The browser smoke check opens and closes only its own harmless local fixture tab, verifies streamed frames, typing and key input, and verifies explicit handback. It refuses to run during an existing takeover. Both read the password file in-process to sign in and never print it.

The tests use synthetic transcripts, a fake Pi process, and a fake DevTools endpoint, so they never touch real BrowserOS. They cover:
- the three parsers, injected-text filtering, partial and oversized records, files deleted mid-scan, and incremental refresh
- redaction in Python and JavaScript
- exact ticket retrieval among 250 noise sessions, varied scores, and semantic scoring
- authentication, per-client throttling, the global backstop, CSRF/Origin and Host checks, the allowed-hosts file, encoded viewer paths, and the internal listener
- viewer input validation, takeover handback, and WebSocket logout revocation
- Pi retry, failure and oversized-record handling, the output limit, process-tree pause and kill, restart recovery, and context retry with nonce-tagged excerpts

Current CopilotKit dependencies include Zod 3, which has an unresolved oversized-collection validation advisory. The app puts its runtime behind authentication and Origin checks, bounds request bodies before validation, and never wires unused Slack/Teams channels or client-supplied MCP servers. Overrides update Undici, Fastify Busboy, and graphql-scalars. The remaining dependency findings are documented limitations, not a clean security audit.

## Upgrading from Session desk

Muster used to be called Session desk. Older installs keep working without changes: `META_*` settings are read as their `MUSTER_*` names, and an existing `~/.local/share/meta-agent` data folder stays in use until a `~/.local/share/muster` folder exists. Settings saved in the browser carry over.

## License

MIT. See `LICENSE`. To report a security problem, see `SECURITY.md`.
