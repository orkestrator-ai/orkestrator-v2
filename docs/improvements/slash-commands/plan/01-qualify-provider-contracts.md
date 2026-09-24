# 01 — Qualify provider contracts and capture fixtures

Status: proposed. Dependencies: none. [Index](00-index.md).

## Purpose

Establish which commands the pinned runtimes can execute through Orkestrator's
actual SDK/bridge paths. Source inspection proves several mismatches, but a
menu or provider CLI manual alone does not establish native-mode behavior.

## Owners and inputs

- Bridge package manifests, `docker/Dockerfile`, and committed Codex protocol.
- `bridges/claude-bridge/src/services/session-manager-catalog.ts` and
  `session-manager-prompt.ts`.
- `bridges/codex-bridge/src/prompts/slash-commands.ts`,
  `app-server-runtime-prompt.ts`, and `engine/app-server-engine.ts`.
- `apps/backend/src/core/opencode-commands.ts` and `opencode-provider.ts`.
- `bridges/pi-bridge/src/agent-session.ts`, `prompt.ts`, and `http.ts`.
- `bridges/acp-bridge/src/acp-session.ts`; Cursor HTTP/session adapter.

Read [testing-guide.md](../../../development/testing-guide.md) and
[agent-testing.md](../../../development/agent-testing.md) before executing
probes. Use disposable provider homes and the isolated profile's test project.
Do not run sample commands against this repository or production sessions.

## Work

1. Record exact installed and managed runtime versions. Resolve differences
   before testing. Do not upgrade dependencies to make a test pass.
2. Create a small qualification matrix, one row per command class and provider.
   Record discovery source, exact canonical name, aliases, argument shape,
   execution method, idle/running behavior, whether a model turn occurs,
   response/transcript shape, configuration changes, and session-ID changes.
3. Create synthetic project and user commands with distinct names and harmless
   outputs. Include a plugin namespace, duplicate command names, mixed case,
   a disabled skill, and a template with multiline arguments. Do not include
   private prompts, credentials, or real file contents in committed fixtures.
4. Probe cold-session discovery before the first prompt and after one normal
   turn. Repeat with project resources enabled/disabled. Compare discovery with
   the actual runtime configuration rather than a separate default CLI.
5. Invoke each chosen fixture through the integration's real execution path.
   Record whether acceptance occurs before completion, and what proves the
   command actually ran. A natural-language model claim is not sufficient.
6. Exercise one command with no model output and one unavailable command. Check
   whether the application reports completion, hangs, or starts a model turn.
7. Modify the fixture inventory while a session exists. Check push updates,
   explicit refresh, idle read, detach/reattach, and restart. Distinguish an
   unsupported refresh from a successful refresh yielding an empty list.

## Provider-specific questions to resolve

| Provider | Required evidence |
| --- | --- |
| Claude | Exact `supportedCommands` rows and aliases; init/`commands_changed` replacement; query/probe configuration parity; `/compact`, `/clear`, and a settings command lifecycle |
| Codex | Enabled/disabled and duplicate-name skill metadata; explicit skill `UserInput`; current template precedence; cold skill discovery without resuming all threads |
| OpenCode | Effective `command.list` response; real source/alias/agent/model/subtask fields; `session.command` with empty and multiline arguments; configured default versus explicit model/agent |
| Pi | Extension-before-template collisions; headless extension completion without a turn; unavailable UI interaction; skill/template literal opt-out; reload while a turn is active |
| Grok | Standard `input.hint`; inventory replacement after attach/load; actual slash text received in `session/prompt`; whether any refresh operation exists beyond updates |
| Cursor | Installed SDK type/docs search for discovery and invocation; absence is recorded as an integration limitation, not filled with editor command names |

For workflow literal mode, determine whether each SDK exposes an actual
command-disable mechanism. Do not assume `allowProviderCommands: false` on the
backend has any effect until it reaches the provider. If literal suppression
cannot be guaranteed, record the limitation and define a tested non-command
input strategy or refuse the ambiguous workflow input before dispatch.

## Fixtures and evidence format

Keep fixtures beside the owning adapter tests or in its existing fixture
directory. Store the minimal provider payload and expected normalized result.
For a transport fixture, include ordering and generation boundaries, not only
the final list. Represent command bodies with synthetic content.

Each qualification record should contain version, fixture identifier, operation,
expected result, observed result, and a passed/failed/not-tested status. Include
the exact test command and bounded artifact location. Do not commit raw provider
recordings; Codex recordings require the repository scrubber and manual review.

## Acceptance and handoff

- Each provider has at least one positive or explicitly unsupported discovery
  case and a failure case.
- Every initially enabled execution category has transport-level evidence.
- Live tests that need unavailable credentials are marked blocked with a
  concrete reason. Those commands remain disabled; mocks do not confer support.
- The support table feeds step 02's contract and steps 05–10's capability gates.
- This step does not expand supported commands, modify live settings, or install
  provider plugins as a side effect of discovery.
