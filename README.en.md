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
- Verified on: official v2.0.24 + Linux/WSL2 + local mock.
- MIT, see [LICENSE](LICENSE).
