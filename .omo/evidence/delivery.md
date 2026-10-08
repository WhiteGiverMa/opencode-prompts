# opencode-prompts 0.1.0 delivery

Official host: unmodified OpenCode v2.0.24 on Linux/WSL2. No production configuration, credentials, services or private prompts used.

## Checks

- Typecheck/build: `bun run typecheck`, `bun run build`, exit 0.
- Unit boundaries: `bun test`, 91 pass / 0 fail / 257 expects.
- Manual provider-transport QA: `node qa/native-v2.mjs`, 26 pass including cross-project isolation. The detailed `native-v2-2.0.24.json` report is generated locally and Git-ignored; it contains synthetic session IDs and machine paths.
- Root LSP error checks: all plugin source files, tests and QA driver clean. JSON/Markdown checked with compiler/schema validation and content review rather than a language server.
- Packed artifact: `opencode-prompts-0.1.0.tgz`, 34 entries including JS/declarations, docs, examples/schema and LICENSE. No source credentials, private bodies, old OMO diff or runtime logs packed.
- Declaration self-check: `tsc --noEmit --strict --types node --target ES2022 --module NodeNext --moduleResolution NodeNext dist/core.d.ts`, exit 0. An initial default ambient-types check exposed installed Bun/Node ambient incompatibility; the Node-consumer check explicitly selects Node types, while project typecheck remains green.

## Independent review

Oracle's concrete log/input collision, unknown-option and reserved-tool-name findings were fixed before completion. Regression tests cover normalized/symlink/hardlink aliases, protected source bytes, strict option rejection and prototype-safe tool inventory. Native cases independently proved definition/template bytes unchanged, no model calls during rejection, and restoration after options repair.

## Cleanup and boundaries

The QA driver finally stopped its private host and mock and removed its temporary sandbox. The legacy SUL close-path patch/worktree is outside this MIT repository and remains uncommitted/unapplied/undeployed. Implementation QA made no host patch, production config change, service restart, npm publication or real external-model request. GitHub source publication is a separately authorized step; it is not a production deployment.

Ordinary primary/subagent dialogue is the dynamic contract. Auxiliary title/compaction/generate and already-admitted work must not be treated as fresh per-request policy handling; stop/drain active work before plugin removal. Windows, real-model instruction adherence and cache behavior were not tested.
