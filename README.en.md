# opencode-prompts

English | [简体中文](README.md)

An MIT plugin for [OpenCode](https://github.com/anomalyco/opencode) v2: a selected native role uses one complete prompt that you own, with per-model template and slot selection.

- No preset role pack, no bundled role text. Agent IDs in the definition must already exist in your own config.
- Managed roles use your text. Removing a role from the definition, disabling the plugin or unloading it restores the native text.
- Edits to the definition, templates and slot files apply on the next request. No rebuild, no service restart.
- A failed render never falls back to the native prompt. It blocks that message and writes a structured reason to the log.

Source repository: [WhiteGiverMa/opencode-prompts](https://github.com/WhiteGiverMa/opencode-prompts). Version 0.1.0 is not published to npm or deployed to production. End-to-end verification covers official OpenCode v2.0.24 on Linux/WSL2 with a local mock provider. See [Tested scope](#tested-scope).

## Install

Requirements: Bun, and the official OpenCode v2 (verified on 2.0.24).

```bash
cd /path/to/opencode-prompts
bun install --frozen-lockfile
bun run build
```

The build produces `dist/`. The root `server.js` only re-exports `dist/server.js`. Then add the plugin as a **directory** in the OpenCode v2 config:

```jsonc
// opencode.json (v2)
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-prompts",
      "options": {
        "definition": "/absolute/path/to/my-prompts.jsonc"
      }
    }
  ]
}
```

Notes:

- `package` points at the repository root **directory**, not a single file. v2 loads it through the package entry, and the root `server.js` re-exports `dist/server.js`.
- The plugin registers no roles. Your existing `agent` entries, `default_agent`, permissions and model preferences stay as they are. The definition only names which agents are taken over.
- After a `plugins` config edit the host reloads the plugin by itself (observed 1 second checks, convergence within about 20 seconds, no host process restart). A restart on first install is still the safest path.
- Do not install this globally, and do not overwrite or modify a v1 setup for it.

### Module options

| Option | Required | Meaning |
| --- | --- | --- |
| `definition` | yes | Path to the definition file. Relative paths resolve from the **active project directory**; `~` is supported. |
| `logFile` | no | Diagnostics path, same relative rules. Defaults to `opencode-prompts.log` next to the definition file. |
| `enabled` | no | Defaults to `true`. When `false`, the plugin reads nothing and registers nothing. |

The two kinds of relative paths differ: module options resolve from the **active project**; `file` values inside the definition resolve from the **definition directory** (`~` and absolute paths supported).

## Quick smoke test

1. Build and configure as above, then restart OpenCode v2.
2. Send any message with the managed role.
3. Open `opencode-prompts.log`; it should contain `"phase":"admission","code":"ok"`.
4. Edit one line of a template file and send again: the new text applies on the next request with no restart.
5. Set `enabled` to `false` or remove the `plugins` entry: the role returns to its native prompt.

## The definition file

The runnable example is [`examples/prompts.jsonc`](examples/prompts.jsonc). Field skeleton:

```jsonc
{
  "version": 1,                       // optional; when present it must be the number 1
  "$schema": "../schema.json",        // optional; only a nonempty string is required
  "agents": {
    "build": {                        // must be an existing native agent ID
      "template": "body...",          // a string, or { "file": "template-path" }
      "slots": {
        "name": "inline text",        // or { "file": "..." }
        "runtime_data": { "runtime": "agent" } // or "model" / "tools"
      },
      "allowRepeatedSlots": false,    // optional, defaults to false
      "rules": [
        {
          "models": ["openai/gpt-*"], // required, at least one entry
          "excludeModels": ["openai/gpt-3*"],
          "template": { "file": "templates/gpt.md" },
          "slots": { "name": "replacement text" }
        }
      ]
    }
  }
}
```

- Keys of `agents` are native agent IDs. The plugin never creates agents and never changes permissions or default models. A definition entry for an agent that does not exist in the host blocks that agent's messages with `agent-missing`.
- A policy only accepts `template`, `slots`, `allowRepeatedSlots`, `rules`. A rule only accepts `models`, `excludeModels`, `template`, `slots`, `allowRepeatedSlots`. Unknown fields fail with `definition-shape` instead of being ignored.
- `template`: inline text or `{ "file": "..." }`. When the default template is omitted, a matching rule must supply one, otherwise the request fails with `template-missing`.
- `slots`: user-named render points. Names must be nonempty and must not contain whitespace, `{`, `}` or `:`. Three sources:
  - string: inline text;
  - `{ "file": "..." }`: read the file (UTF-8);
  - `{ "runtime": "agent" | "model" | "tools" }`: insert raw host data. Strings render as-is; other values render as 2-space JSON.
- `rules` match in array order. Every matching rule applies, and later rules override earlier fields. `slots` merge **by name**: a later rule only replaces the names it declares, all other slots stay.
- `models` patterns are anchored, case-sensitive globs over the full `providerID/modelID` ref, and `*` / `?` also span `/`. For example `openai/gpt-*` matches `openai/gpt-5`, `openai/*` matches every model under `openai`, and `*/gpt-4o` matches `gpt-4o` from any provider. There is no family inference; matching is literal. If any `excludeModels` pattern matches, the whole rule is skipped.
- In the final template every declared slot must appear exactly once: `{{name}}` to use it, `{{name:omit}}` to omit it explicitly. Repeating a used slot requires `allowRepeatedSlots: true`. Repeated `{{name:omit}}` is never allowed, and a slot cannot be both used and omitted. An undeclared placeholder fails with `slot-unknown`; an empty name or unknown modifier (only `:omit` exists) fails with `template-parse`.
- An omitted slot never reads its source file. `\{{` escapes to a literal `{{`.
- Inserted slot content is string concatenation only, never parsed as a template again: inner `{{...}}` or `$&` stay as written.
- The definition is JSONC: comments and trailing commas are supported.

You can check a definition and its render without starting OpenCode:

```bash
node --input-type=module -e "
import { loadDefinition, preparePrompt } from './dist/core.js';
const file = './examples/prompts.jsonc';
const def = loadDefinition(file);
const prepared = preparePrompt(def, file, 'assistant', 'openai/gpt-5');
console.log(prepared.render({ agent: 'assistant', model: { providerID: 'openai', id: 'gpt-5' }, tools: {} }));
"
```

This prints the exact body that model would receive. Swap the model for `anthropic/claude-sonnet-4-6` to see the default template.

## When changes apply

- Definition, template and slot files: next message, no build or restart.
- Role additions and removals: a removed role restores its native text on its next message and logs `restored`; a newly added role is taken over on its next message.
- Seeding happens at admission time, so a role must send a message before it is actually managed.
- After mount, the plugin first registers only the admission and context hooks. The `agent.transform` that writes the seed is registered on the first managed admission, so it never races the native config build.
- A definition that is already broken at startup keeps the admission guard in place. Every send is blocked and logged, and the same session works again as soon as the definition is fixed.
- Normal primary and subagent requests re-read the definition and render fresh each time; no previous render is reused.

## When something is wrong

The default log is `opencode-prompts.log` next to the definition file, one JSON object per line (JSONL). `logFile` changes the path. If the module options themselves are wrong (for example `definition` is missing), diagnostics can only go to the server's stderr, because no log path is known yet.

Every line has at least `ts`, `phase`, `code`, `hint`, plus `session`, `agent`, `model`, `file`, `slot`, `count` and `locations` (line/column) when known. Logs only carry paths, slot names, codes, counts and positions. Prompt bodies, slot content, file content and credentials are never written.

The four `phase` values:

| phase | Meaning |
| --- | --- |
| `startup` | Result of loading the definition when the plugin starts. |
| `admission` | A message tries to enter: resolve agent and model, validate the definition, prepare the seed. A failure blocks the message before the model runs, and no user message is committed to the session. |
| `context` | Fresh render before an actual model request. |
| `cleanup` | Cleanup when the plugin is disabled or unloaded. |

`code` values `ok`, `unmanaged` and `restored` are informational. Everything else needs a fix:

| code | Meaning and fix |
| --- | --- |
| `options-invalid` | Check the required `definition`, option spelling/types, and that `logFile` does not alias a definition, template or slot input. Correct plugin options and wait for the host to reload. |
| `definition-read`, `template-file`, `slot-file` | A path is missing or unreadable. Check the `file` field, the path and permissions. |
| `definition-json` | JSONC syntax error. Use the `locations` line and column. |
| `definition-shape` | Wrong field shape: unknown field, wrong type, empty string. Compare with `schema.json`. |
| `template-missing` | No matching rule supplies a template for this model. Add a default `template` or a rule. |
| `template-parse` | Placeholder syntax error: empty name, unknown modifier, unterminated `{{`. |
| `slot-unknown`, `slot-missing`, `slot-repeated`, `slot-omit-repeated`, `slot-conflict` | Slots and template disagree: undeclared, never referenced, repeated use without `allowRepeatedSlots`, repeated omit, or both use and omit. Follow the `hint`. |
| `slot-value`, `runtime-value` | A used slot has no usable value. Usually an internal precondition or missing runtime data. |
| `agent-missing`, `agent-unresolved`, `model-unresolved` | The role does not exist in the host, or the session has no agent/model and the host has no default. Check the native config. |
| `tools-unavailable` | A tool input schema cannot be converted to plain JSON, so the `tools` slot cannot render at admission. Disable that tool or drop the `tools` slot. |
| `seed-missing`, `unmanaged-marked`, `region-missing`, `region-duplicate`, `region-malformed` | The seed or owned marker region is in an unexpected state. Send the message again; `region-duplicate` means the plugin markers appear more than once. |
| `unexpected` | Outside the plugin surface; check the OpenCode server logs. |

After fixing definition, template or slot content, send another message. Every admission re-reads those files; the same session needs neither rebuild nor restart. Invalid plugin options or log/input collisions must instead be corrected in the OpenCode configuration so the plugin reloads. Unknown enabled options are rejected, not silently ignored. A colliding log destination is never written; diagnostics go to stderr and requests remain blocked.

The UI may show the host's own generic "failed to send" notification. That is the native failure notice; the plugin adds no custom toast or modal, so use the log.

## Disable and roll back

The plugin never changes your project sources or OpenCode config. It only appends diagnostics next to the definition file (or where `logFile` points). Rollback means dropping the reference:

1. Let the in-flight turn finish. Disabling or unloading only affects later requests; it does not cancel running work, and an already admitted frame is not rewritten.
2. Pick one:
   - set the module option `enabled` to `false`;
   - remove the entry from the `plugins` array;
   - roll back a single role: remove it from the definition's `agents`, other roles stay managed.
3. The affected role returns to its native text on its next message. Removing a role logs `restored`; disabling or unloading logs `cleanup` on that instance.
4. For a full cleanup, delete the config entry and the repository directory.

Disable, entry removal and re-adding were all verified in QA.

## Tested scope

- Host: official, unpatched OpenCode **v2.0.24**, configured through v2's `plugins: [{ package, options }]`. Older and newer versions are untested.
- Platform: Linux/WSL2. No Windows QA.
- Provider: a local loopback mock with synthetic requests and responses. No real-model instruction adherence, cache hit rate or cross-provider behavior was verified.
- All 26 cases passed; details in `.omo/evidence/native-v2-2.0.24.json`: broken definition at startup with in-session repair, unmanaged passthrough, full replacement with host/neighbor system parts preserved, default agent and model resolution, template and slot switching per model, opt-in repeated slots, hot template/slot edits, per-request re-render, native subagent model inheritance, six invalid-definition classes blocked without leaking bodies, role removal restoration, disable/unload/re-add, concurrent session and cross-project isolation, and rejection/repair of log/input collisions and misspelled options.
- Re-run QA with `node qa/native-v2.mjs`. It uses the official binary under `$HOME/.local/opt/opencode-v2/2.0.24` by default; override with `OPENCODE_V2_BINARY=/path/to/opencode2`. It starts the host and mock inside isolated HOME, config, database and temp directories, touches no production config or the 4097/4098 ports, and writes `.omo/evidence/native-v2-2.0.24.json`. Detailed reports contain local paths and synthetic session IDs, so they are generated locally and Git-ignored; the repository retains the delivery summary and repeatable driver.

On auxiliary calls: host-internal maintenance requests such as title generation, compaction and generate are not covered by the "every dialogue request renders from your definition" guarantee. In the tests the title request kept its native prompt. Do not try to manage these hidden maintenance roles through the definition.

## Examples and schema

- [`examples/prompts.jsonc`](examples/prompts.jsonc): a copy-ready definition. Rename `assistant` to the role you use (for example `build`) and adjust the paths.
- [`examples/templates/default.md`](examples/templates/default.md), [`examples/templates/gpt.md`](examples/templates/gpt.md): default and GPT family templates with dynamic slots and `{{...:omit}}`.
- [`examples/slots/common.md`](examples/slots/common.md): a shared slot file.
- [`schema.json`](schema.json): a JSON Schema that mirrors the decoder, for editor completion and validation.

## Provenance

The same workspace holds a separate legacy prompt switch patch for OMO (oh-my-openagent) LTS: `../.omo/evidence/20261007-opencode-prompts/legacy-prompts-gates.patch`, outside this repository. It is independent of this MIT package and is **not applied and not deployed**. Do not copy its content into this repository.

## License

MIT, see [LICENSE](LICENSE).
