# Modules

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

## How modules run

Each call runs in its own process with a small environment: no Muster credentials, Pi settings or tokens. A module reads its settings from a context object and may contact only the hosts in its manifest's `network` list and in URLs in its own settings, over https (http only on loopback). Secret settings are write-only in the form, stored in `modules/secrets.json` (mode 600, not encrypted at rest) and never sent to the page or the agent. Modules are code you choose to run on your desktop, like Pi extensions: these limits prevent accidents, not a module written to do harm.

**Actions** take three steps: fill in the form, read the preview, confirm. An action runs only with the token of a preview of exactly those inputs, shown in the last ten minutes, and each token works once. Muster enforces this, not the module. Every run is logged in `modules/activity.jsonl`.

**Inbox feeds** are checked on their own schedule; Muster keeps the latest 500 items in `modules/inbox.json`. New messages go to your default Pi model, together with the open requests, and come back grouped into **requests**: what someone needs you to do or answer, with a title, a short summary, who's asking and a priority. A follow-up joins the request it continues. Messages that ask nothing of you (thanks, updates, FYIs, small talk) are kept under **Other messages**. **Start session** on a request opens a thread with the ask and its messages in the message box; **✓** marks it done.

**Agent tools** of enabled modules are offered to every managed thread from its next message. Each call goes through Muster's loopback-only internal API with the thread's capability token, and long output is trimmed to 40,000 characters. Calls are logged with their inputs, not their results. Tools should only read; anything that changes something belongs in an action.

**Pull-request providers** declare link templates, such as `bitbucket.org` and `/{owner}/{repo}/pull-requests/{number}`. Links the assistant posts that match one appear in the session's **Files → Pull requests** tab. Muster owns the review: **Review diff** shows the provider's snapshot file by file, and **I've reviewed this diff** records your sign-off against the exact source commit, target commit and diff, which Muster fingerprints itself. The provider's merge action must carry the `reviewed-pr` policy, so Muster refuses its preview and its run, from any screen, unless you reviewed that exact revision and the PR belongs to that module. A push after your review means reviewing again.

A module that lists `"connectors": ["composio"]` gets `ctx.composio(url, {toolkit})`, which calls an app's API through the Composio CLI signed in on this desktop, so no token passes through Muster. The URL's host must still be in the module's `network` list.

## Writing a module

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
