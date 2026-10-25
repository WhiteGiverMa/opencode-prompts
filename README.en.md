# opencode-prompts

English | [简体中文](README.md)

A prompt plugin for OpenCode v2: give an existing agent in your config one complete prompt of your own, with per-model template selection.

## What it does

- Replaces the agent's system prompt with your file; different models (GPT, Kimi, GLM, ...) can get different templates.
- Templates take named slots, filled from inline strings, files, or runtime data (agent / model / tool list).
- Slot rules are strict: a declared slot is used exactly once, or explicitly dropped with `{{name:omit}}`. A broken definition blocks the message before the model runs and logs the reason — no silent fallback to the native prompt.
- Editing a template applies on the next message, no restart. Disabling the plugin or removing an agent from the definition restores that agent's original config.

It registers no agents, changes no permissions, and doesn't touch default models — the definition is just a takeover list.

## Install

Requires Bun and OpenCode v2 (verified on 2.0.24).

```bash
bun install --frozen-lockfile
bun run build
```

Then add one entry to the `plugins` array of your v2 config, with `package` pointing at this repository **directory**:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/opencode-prompts",
      "options": { "definition": "/absolute/path/my-prompts.jsonc" }
    }
  ]
}
```

Options: `definition` is required (path to the definition file; relative paths resolve from the active project, `~` supported); `logFile` is optional (defaults to `opencode-prompts.log` next to the definition file); `enabled` defaults to `true`.

## The definition file

```jsonc
{
  "agents": {
    "build": {                        // an agent ID that already exists in your config
      "template": { "file": "templates/default.md" },
      "slots": {
        "identity": { "file": "slots/identity.md" },
        "model_info": { "runtime": "model" }
      },
      "rules": [
        { "models": ["*gpt-*"], "template": { "file": "templates/gpt.md" } }
      ]
    }
  }
}
```

- `template`: inline string or `{ "file": "…" }`; `file` resolves relative to the definition file's directory.
- `slots`: three sources — a string, `{ "file": "…" }`, or `{ "runtime": "agent" | "model" | "tools" }`.
- `rules`: case-sensitive globs over the full `providerID/modelID` (`*` spans `/`). Every matching rule applies in array order, later rules override earlier fields; a hit in `excludeModels` skips the rule.
- In the template, `{{name}}` uses a slot and `{{name:omit}}` drops it explicitly; every declared slot must appear exactly once. Slot content is plain string concatenation, never re-parsed.

A runnable example lives in `examples/` — copy the whole directory and swap in your own agent ID. `schema.json` gives your editor completion.

## Troubleshooting

When a message is blocked, read the log: JSONL, one line per event with `phase`, `code`, `hint` and file positions. The usual suspects — broken JSONC (`definition-json`), unused or repeated slots (`slot-missing` / `slot-repeated`), unreadable template (`template-file`), unknown agent in the host (`agent-missing`). Fix the file and send again; the same session recovers without a restart.

## Usage limitation: automatic recovery after a restart

The plugin template owns a managed agent's role body. You **do not need** to duplicate it in OpenCode's `agents.<id>.system`. Omitting that field or setting it to `""` is valid; the host then uses its built-in default. However, the current public plugin API exposes neither reliable role-body provenance nor an awaited preflight before a resumed request selects its agent, so automatic recovery is not fully supported:

| Scenario | Current behavior |
| --- | --- |
| An unmanaged agent | Unchanged host behavior; not affected |
| A new ordinary user message to a managed agent | Admission establishes the seed, then the template is used; native `system` may be omitted or empty |
| Automatic recovery after restart with a nonempty native `system` that uniquely and exactly matches a request part | Automatically reseeded; logs `context/reseeded` |
| Automatic recovery of a managed agent with native `system` omitted or `""` | The resumed request can fail with `region-missing` before model dispatch |
| An earlier hook rewrote, wrapped or duplicated the markerless native body, preventing a unique exact match | Also blocked conservatively rather than guessing which part to overwrite |

This is a **known recovery compatibility gap, not a configuration error**. The plugin will not overwrite `system[0]` or retain the default body alongside an appended template to bypass ownership checks. Independent parts added by other plugins are preserved; prefixes and suffixes outside an existing valid marker pair are preserved too.

After this error, **send a new ordinary user message** in the same session so admission can establish a fresh seed. Waiting, pressing continue, or repeating synthetic/resume work does not guarantee recovery. For automatic recovery, a workaround is to configure a nonempty fallback `system` suitable for use when this plugin is disabled. It is not the template body and need not duplicate it; the earlier-hook limitation above still applies. `system: ""` does not mean there is no system prompt.

### Hot reload

When OpenCode hot-reloads this plugin, the host can keep the previous generation's complete marker region or fail to write the new generation's transform back into the registry. The `context` hook now takes over a stale owned region directly, logs `seed-deferred`, and lets the request continue. Only foreign, duplicated, reordered, or altered markers still block. `agent.transform` is therefore best-effort; the context renderer guarantees the actual request body.

The project currently keeps the host unmodified and retains ownership checks. Full support requires a reliable host preflight or role-provenance API. See the [known-issue record](docs/known-issue-region-missing-after-restart.md) for reproduction, evidence and the missing host capability.

## Etc

- Preview a render offline, without starting OpenCode:

  ```bash
  node --input-type=module -e "
  import { loadDefinition, preparePrompt } from './dist/core.js';
  const file = './examples/prompts.jsonc';
  const def = loadDefinition(file);
  const prepared = preparePrompt(def, file, 'build', 'openai/gpt-5');
  console.log(prepared.render({ agent: 'build', model: { providerID: 'openai', id: 'gpt-5' }, tools: {} }));
  "
  ```

- Full QA: `node qa/native-v2.mjs` boots the official binary with a mock provider in an isolated environment, 26 cases.
- Restart recovery QA: `node qa/restart-resume.mjs` SIGKILLs an isolated `serve --service` with two in-flight sessions sharing one agent and using different models. The default case checks recovery with a nonempty native system and independent neighbor parts. `QA_SYSTEM_MODE=omitted` / `empty` reproduce the known gap; `QA_NEIGHBOR_MODE=wrapped` reproduces the restriction on wrapping a markerless role body before recovery. These gap cases currently exit nonzero; they are not fixed. Set `OPENCODE_V2_BINARY` to select a host binary.
- Hot reload QA: `node qa/hot-reload.mjs` (touches the copied plugin artifact) or `QA_RELOAD_MODE=config node qa/hot-reload.mjs` (adds a plugin through config) reloads the plugin during an in-flight turn in an isolated `serve --service` and verifies the stale region is taken over without `seed-missing`.
- Verified on: official v2.0.24 + Linux/WSL2 + local mock.
- MIT, see [LICENSE](LICENSE).
