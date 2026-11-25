# @agentmuster/module-sdk

What a Muster module is written against: the types of the module API (apiVersion 1), `defineModule`, `prFingerprint` for pull-request providers, a JSON Schema for `muster-module.json`, and a fake context for tests.

Muster provides this package to installed modules at run time, so a module imports it without listing it as a dependency:

```ts
import {defineModule} from '@agentmuster/module-sdk';
import {createTestContext} from '@agentmuster/module-sdk/testing';
```

`createTestContext({settings, secrets, fetch, composio, network})` returns a context whose `fetch` and `composio` answer with the handlers you pass. It records every request in `ctx.requests` and refuses hosts outside `network`, as Muster does.

For editor checks, point your manifest at the schema:

```json
{"$schema": "https://raw.githubusercontent.com/agentmuster/muster/main/packages/module-sdk/manifest.schema.json"}
```

See the modules repository, [muster-modules](https://github.com/agentmuster/muster-modules), for examples and a template.
