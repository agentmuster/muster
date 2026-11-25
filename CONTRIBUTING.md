# Contributing

Thanks for helping. Bug reports, fixes and new modules are all welcome.

## Setting up

You need Node 22.23 or later, Python 3 with the packages in `requirements.txt`, and the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) CLI.

```sh
npm install
python3 -m pip install -r requirements.txt
npm run build
npm start
```

## Before you open a pull request

```sh
npm run typecheck
npm test
npm run build
```

The tests use a fake Pi process, synthetic transcripts and a fake browser endpoint, so they need no model account or API keys. Add a test for any behaviour you change.

- Keep pull requests to one change.
- Match the surrounding code: its naming, comments and structure.
- Never commit real transcripts, session IDs, tokens or personal paths. Use synthetic fixtures in `test/fixtures`.
- Anything that changes something outside Muster, such as a deploy or a merge, needs a preview and an explicit confirmation from the owner.

## Modules

Integrations with other services belong in modules, not in the core app. See the Modules section of the README for the manifest and the module API.

## Conduct

Be kind and assume good intent. This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Report problems privately through the repository's Security tab or to a maintainer listed on GitHub.
