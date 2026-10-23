## Summary

Implements todo [0054](docs/todo/cross-cutting/0054-agent-test-pi-default-model.md). A Pi session that names no model now starts on Pi's saved default, the way `pi` itself does. An agent-test profile that shares the host's Pi login also receives the host's saved default.

**Root cause.** The problem was wider than agent-test. With no explicit model, the bridge passed the catalogue's first model to the SDK explicitly, so Pi never read `defaultProvider`/`defaultModel` from any settings file. On a ChatGPT-backed `openai-codex` login, that first model (`gpt-5.3-codex-spark`) is refused. That was the 2026-10-22 live failure.

## Changes

- **Bridge** (`agent-session.ts` `defaultModelIds`, `models.ts`, `config.ts`): with no explicit selection, the bridge uses Pi's saved default when a signed-in provider serves it, then `PI_BRIDGE_DEFAULT_MODEL`, then the catalogue's first model. A project's `.pi/settings.json` counts only when the session trusts the project. An explicit selection still wins. The preference applies on create, resume, retried hydration, composer apply and SDK attach.
- **Backend** (`host-agent-credentials.ts` `readPiDefaultModel`): when an authorized agent-test profile is given the host `auth.json`, the backend also reads `defaultProvider` and `defaultModel` (only those two keys) from the host's `settings.json`. The read is bounded to 1 MiB and BOM-tolerant. It passes them as `PI_BRIDGE_DEFAULT_MODEL`. Production and unauthorized profiles get neither variable, and an inherited one is deleted. Nothing is written into the profile.
- **Tests:** a new `agent-session-default-model.test.ts`, `models.test.ts` cases, backend unit tests and the standalone agent-test launch test. A Pi-bridge preload (`src/testing/test-isolation.ts`, wired into `test:bridge`) keeps every bridge test off the developer's `~/.pi/agent`.
- **Docs:** the root and Pi-bridge `AGENTS.md`, `agent-engines.md`, `credentials-and-models.md` and `agent-testing.md`; the 0054 file (with **Assumptions and decisions**) and its index row; 0024's owed rerun; a new todo [0056](docs/todo/cross-cutting/0056-agent-test-stale-bridge-builds.md); and flake case 0694.

## Decisions

1. **Fix the bridge's model choice, not only the profile.** Seeding the profile's settings alone would have changed nothing, because the bridge never read them. Having the live suites pick a model would leave real users' default-less tabs on a model their login may refuse. Con: a user-visible change. A Pi tab with no explicit model now opens on the user's saved `pi` default instead of the catalogue's first model.
2. **Pass the host default as an environment variable, not a file seed.** It is read at each bridge start, so a host change or revocation applies at the next start. Nothing is written into a file Pi also writes. The profile's own saved default still comes first. Rejected: seeding `settings.json` at `dev:test` start, which needs provenance tracking to refresh or revoke the seed.
3. **Keep the catalogue's first model as the last resort.** Pi's own per-provider fallback table is not exported by the SDK, and a copy would drift.
4. **Project settings count only for a trusted project**, the same rule the bridge applies to project resources.
5. **The default travels only with the login.** Without `auth.json` there is no `PI_BRIDGE_DEFAULT_MODEL`.
6. **No model override for the live coordinator suite.** That suite deliberately launches with no model, so it tests the path users take.
7. **The host's Pi settings were not edited** to make a live run pass.
8. **Test isolation with a Pi-bridge-only preload.** Putting it in the shared `tests/setup-node.ts` could change backend and desktop tests that read `PI_CODING_AGENT_DIR`.

## Multi Review

Workflow `action-1f924c0eae2086c4caa691c5f4145ee3`, verdict with-fixes, with no correctness or security defect. All three P2 findings and all three coverage gaps were fixed:

- The fallback comments were too narrow.
- The pause-suite comment was stale.
- The tests read the developer's Pi settings.
- Gaps covered now: resume, retry, apply and attach-to-prompt wiring; the fallback's slash and byte-bound cases; the settings-size bound.

Mutation checks confirm that removing the preference from any one wiring point fails a test.

## Live qualification — needs user action

`mise run test:agent:coordinator --credential-source pi` was run twice on 2026-10-23.

1. The first run used a stale `bridges/pi-bridge/dist` and started on `gpt-4`. That build predates this change; see 0056.
2. After `bun run --cwd bridges/pi-bridge build`, every scenario started on the host's saved default `openai/gpt-5.5`, so the fix works on the real stack. It still failed, because this host's ChatGPT-backed `openai` login refuses `gpt-5.5` too.

**A passing run needs the user to save a Pi default model their login can run** (`/model` in `pi`; the pause suite pins `openai/gpt-6-sol` for this kind of login). Then rebuild the Pi bridge and rerun.

## Tests

- `mise run format:check`, `mise run lint` and `mise run typecheck` pass.
- The new and changed focused suites pass: Pi bridge `test:bridge`, backend `host-agent-credentials.test.ts` and the standalone agent-test launch test.
- `mise run test` (at `369be1653`) exited 1. The root, bridges and lockfile groups passed. Within the workspace group, only backend failed, on four timeouts in files this change does not touch: terminal history, Firefox artifact policy, Mermaid watchdog and environment move. All four owner files passed when rerun alone (114 passed). They are recorded in flake case 0694 together with an earlier, similar cluster.
- Browser, Electron, Docker and iOS suites were not run; this change touches none of those areas.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
