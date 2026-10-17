# Live-provider and platform qualification

Checked against `main` at `2459b05c` (2026-10-15).

Most features ship with unit, contract and credential-free real-stack coverage
on Linux. The gate that is missing most often is the same everywhere: a run
against real providers, or on a platform the repository's CI does not have
(macOS, Docker Desktop, a real Electron window, Safari and iOS, a second
machine). This file holds what those runs share: the prerequisites, a batching
index so that one session on a platform, or with one provider's credentials,
closes items in several todo files at once, the checks that have no other home,
and the test-profile isolation gap that makes live results less trustworthy.

The owning todo file keeps the detail of what to assert and records the
evidence. This file only points at it.

## Current state

- Isolated profiles: `mise run dev:test --profile <name> --fixture`, narrowed
  with `--credential-source <name>` (repeatable), `--agent-platforms <list>`,
  `--no-agent-credentials` and `--fixture-environments local,container`. The
  procedure is in [`agent-testing.md`](../development/agent-testing.md) and the
  per-platform credential matrix is in
  [`credentials-and-models.md`](../development/credentials-and-models.md).
- One-shot and opt-in suites that live runs use:
  - `mise run test:agent:browser:isolated` and `mise run test:agent:design:isolated`
    (disposable profile, then stop and reset);
  - `mise run test:agent:browser` against an already running profile;
  - `mise run test:agent:docker` (only tests whose title matches `Docker fixture`);
  - `mise run test:agent:electron` (`e2e/agent-testing/playwright.electron.config.ts`);
  - `mise run test:cli:scenarios` (credential-free unless `--provider`);
  - `mise run verify:opencode:live`;
  - opt-in env gates such as `ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE=1`
    (`e2e/agent-testing/opencode-live.spec.ts`) and
    `ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1`
    (`e2e/agent-testing/web-annotations-gateway.spec.ts`).
- CI (`.github/workflows/lint.yml`, `publish-container.yml`,
  `validate-bun-runtime.yml`) runs no live provider, no Docker live suite, no
  Electron window, and no macOS or iOS job. The only platform evidence CI adds
  is the native amd64 and arm64 final-image smoke.
- Almost all recorded evidence is from Linux amd64 with Docker Engine 29.7.2,
  taken before the SQLite storage migration (#969) and the October agent
  upgrades (#964).
- Current agent pins: Claude Agent SDK 0.3.296 / CLI 2.1.296, Codex 0.162.1,
  OpenCode 1.19.0, Cursor SDK 1.0.37, Grok 1.0.52 (ACP SDK 1.8.0), Pi 1.2.0.
- Agent-test isolation: `checkHostTool` (`apps/backend/src/core/host-tools.ts`)
  reports only managed binaries in an agent-test profile, but spawning does
  not match it. `resolveClaudeBinary`, `resolveCodexBinary`,
  `resolveOpenCodeBinary` and `resolvePiBinary`
  (`apps/backend/src/core/commands-agent-support.ts`) fall back to the bare
  name on `PATH` in every runtime flavour. Only Cursor and Grok
  (`resolveManagedAcpBinary`) never fall back. `agent-testing.md` describes
  the fallback as intentional: it lets Claude, Codex and OpenCode run in a
  profile that provisioned nothing.

## Outstanding work

### Code

1. **Decide and align agent-test binary resolution.** Either keep the `PATH`
   fallback in agent-test profiles (and say in `agent-testing.md` that
   availability reporting and spawning differ), or refuse it for platforms the
   profile did not provision. With the second option, a launch requested
   directly through the backend could not reach a host binary that the profile
   reports as unavailable.
2. **Refresh the live OpenCode spec** (`e2e/agent-testing/opencode-live.spec.ts`)
   for the shipped fixes. Since #985 no fixed default model ships, and since
   #975 forks keep their model.
   - Make `ORKESTRATOR_AGENT_TEST_OPENCODE_MODEL` optional; an unset model now
     resolves to a connected default. Keep it for the build-pipeline case,
     which needs a model that emits reasoning.
   - Rewrite the header comment and the `requirePinnedModel` error message,
     which still describe the old default failure.
   - Assert that the fork tab keeps the source's model and reasoning profile
     before its first prompt. The spec currently skips this on purpose.
   - Make the undo case assert that the reverted turn disappears; today it
     only checks the toast and an idle turn.
   - Update the matching paragraph in `agent-testing.md` (see "Related").
3. **A dev profile's backend reports the Electron version.** In a `dev:test`
   profile the backend starts as "Orkestrator 44.7.0": `ORKESTRATOR_VERSION`
   comes from an unpackaged Electron's `app.getVersion()`
   (`apps/backend/src/core/constants.ts:147`). The renderer is 2.21.1, so
   every event-stream reconnect raises "Reload to use the matching version"
   (`BackendVersionReminder.tsx`). The toast sits over the composer's Send
   button and intercepts browser-spec clicks; `slash-command-inactive.spec.ts`
   dismisses it with a locator handler. Pass the workspace package version in
   development, or skip the reminder for agent-test profiles.

### Qualification: checks with no other home

- **Codex sub-agent cards.**
  - Start a fixture profile: `mise run dev:test --profile <p> --fixture --credential-source codex --agent-platforms codex`.
  - Run synthetic work that launches distinct children plus one spawn rejected
    at capacity. Observe the configured limit rather than assuming one.
  - Verify:
    - one card per successful child;
    - the failed attempt is visible and not counted as active;
    - child transcripts load;
    - status, transcript and controls are correct after finishing in an
      inactive environment, after a reload, and after restarting the isolated
      stack (cold identity recovery from child session headers);
    - no finished child is left on a permanent spinner.
- **Electron terminal input resume.** Re-run `mise run test:agent:electron` for
  `e2e/agent-testing/terminal-input-resume-electron.spec.ts`. The review
  follow-up of #986 did not re-run the Electron suite. Confirm that Resume
  keeps the same PTY process id.
- **Live OpenCode spec.** One live run after the refresh above. Also check
  whether OpenCode 1.19's `session.fork` fills in `Session.model`. The fix
  falls back to the source session's model either way.
- **Runtime drift and advisories.** On two platforms, the Agent Info runtime
  section shows drift counters and an advisory notice, and both rehydrate after
  a reload.
- **Transcript part coverage.** Drive a compaction (Claude or Pi), an image
  round trip and a long-running tool. Switch tabs, let the turn finish in the
  inactive environment, then return and reload. The compaction, retry, status
  and image parts must render from the snapshot.
- **Usage panel.** On two providers, the usage panel shows turns and account
  windows and keeps them across a reload.
- **OpenCode inactive path.** Start a turn, switch environment, let it finish,
  return, reload. Record the poll count.
- **Grok tool output.** Terminal output from a Grok shell call renders inline
  and survives a reload. The upgrade runbook already covers the argv and
  handshake check for each Grok bump.

### Qualification: batching index

Platform runs, and the todo files with items for each:

| Run | Items in |
| --- | --- |
| macOS host with Docker Desktop (Apple Silicon) | [container-platform-qualification.md](container-platform-qualification.md), [container-state-observation.md](container-state-observation.md), [container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md), [environment-and-disk-cleanup.md](environment-and-disk-cleanup.md), [service-preview-rollout.md](service-preview-rollout.md), [cli-qualification.md](cli-qualification.md), [recurring-work-qualification.md](recurring-work-qualification.md), [web-annotation-qualification.md](web-annotation-qualification.md) |
| Real Electron window (`mise run test:agent:electron` or a manual pass) | [service-preview-rollout.md](service-preview-rollout.md), [web-annotation-qualification.md](web-annotation-qualification.md), [design-canvas-qualification.md](design-canvas-qualification.md), [transcript-history-efficiency.md](transcript-history-efficiency.md), [recurring-work-qualification.md](recurring-work-qualification.md) |
| Docker live suites and `mise run test:agent:docker` | [container-platform-qualification.md](container-platform-qualification.md), [container-rebuild-state-preservation.md](container-rebuild-state-preservation.md), [container-state-observation.md](container-state-observation.md), [environment-and-disk-cleanup.md](environment-and-disk-cleanup.md), [mcp-management.md](mcp-management.md), [mcp-environment-delivery.md](mcp-environment-delivery.md), [web-annotation-qualification.md](web-annotation-qualification.md), [design-canvas-qualification.md](design-canvas-qualification.md), [slash-command-qualification.md](slash-command-qualification.md), [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), [transcript-history-efficiency.md](transcript-history-efficiency.md) |
| Rootless Docker Engine, arm64 live suites, registry pulls | [container-platform-qualification.md](container-platform-qualification.md), [container-network-and-credential-isolation.md](container-network-and-credential-isolation.md), [container-resource-budgets-and-performance.md](container-resource-budgets-and-performance.md) |
| Two machines or a remote backend | [service-preview-rollout.md](service-preview-rollout.md), [web-annotation-qualification.md](web-annotation-qualification.md), [remote-client-bandwidth.md](remote-client-bandwidth.md), [mcp-management.md](mcp-management.md) |
| Firefox, Safari, iOS device or simulator, narrow real browser | [service-preview-rollout.md](service-preview-rollout.md), [embedded-service-previews.md](embedded-service-previews.md), [web-annotation-qualification.md](web-annotation-qualification.md), [recurring-work-qualification.md](recurring-work-qualification.md), [transcript-history-efficiency.md](transcript-history-efficiency.md), [mobile-layout-gaps.md](mobile-layout-gaps.md) |
| Live GitHub (`gh` against a real repository) | [recurring-work-qualification.md](recurring-work-qualification.md) |

Provider runs (credentials needed). Every provider also has items in [native-agent-idle-observation.md](native-agent-idle-observation.md), [slash-command-qualification.md](slash-command-qualification.md), [coordinator-live-conformance.md](coordinator-live-conformance.md), [web-annotation-qualification.md](web-annotation-qualification.md); the table lists the rest:

| Provider | Items in |
| --- | --- |
| Claude | [mcp-management.md](mcp-management.md), [mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md), [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), [agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md), [transcript-history-efficiency.md](transcript-history-efficiency.md), [session-lifecycle-consistency.md](session-lifecycle-consistency.md), [design-canvas-qualification.md](design-canvas-qualification.md), [design-agent-conversation-links.md](design-agent-conversation-links.md) |
| Codex | [mcp-management.md](mcp-management.md), [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), [agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md), [session-titles-and-history.md](session-titles-and-history.md), [container-platform-qualification.md](container-platform-qualification.md), [design-canvas-qualification.md](design-canvas-qualification.md), [design-agent-conversation-links.md](design-agent-conversation-links.md), the sub-agent cards check above |
| OpenCode | [mcp-management.md](mcp-management.md), [container-platform-qualification.md](container-platform-qualification.md), [session-lifecycle-consistency.md](session-lifecycle-consistency.md), the live spec and inactive-path checks above |
| Cursor | [cli-qualification.md](cli-qualification.md), [mcp-management.md](mcp-management.md), [mcp-environment-delivery.md](mcp-environment-delivery.md), [mid-turn-steer-and-interrupt.md](mid-turn-steer-and-interrupt.md), [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), [session-lifecycle-consistency.md](session-lifecycle-consistency.md), [session-titles-and-history.md](session-titles-and-history.md), [composer-model-parameters.md](composer-model-parameters.md), [transcript-history-efficiency.md](transcript-history-efficiency.md), [container-platform-qualification.md](container-platform-qualification.md) |
| Grok | [cli-qualification.md](cli-qualification.md), [mcp-management.md](mcp-management.md), [session-lifecycle-consistency.md](session-lifecycle-consistency.md), [transcript-history-efficiency.md](transcript-history-efficiency.md), [container-platform-qualification.md](container-platform-qualification.md), [provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md), the tool-output check above |
| Pi | [cli-qualification.md](cli-qualification.md), [mcp-environment-delivery.md](mcp-environment-delivery.md), [agent-interactions-and-permissions.md](agent-interactions-and-permissions.md), [session-lifecycle-consistency.md](session-lifecycle-consistency.md), [session-titles-and-history.md](session-titles-and-history.md), [container-platform-qualification.md](container-platform-qualification.md) |
| Several providers at once (mixed panels) | [multi-review-scale-and-cost.md](multi-review-scale-and-cost.md), [multi-review-panel-value.md](multi-review-panel-value.md) |

## Constraints and rationale

- Live runs are opt-in, cost tokens and can have external effects. Use only
  the seeded fixture project and synthetic prompts. Never use real prompts,
  production sessions or this repository as the fixture, and keep credentials
  out of test output.
- A skipped or timed-out run is not a pass. Record a provider without
  credentials as skipped, not as passing.
- Never claim live or Docker coverage from scripted adapters or fakes, and
  never use one platform's result for another. WebKit on Linux is not Safari
  evidence; Docker Engine on Linux is not Docker Desktop evidence.
- Record the commit, platform and versions, provider pins, exact command, exit
  status, counts, skipped cases and cleanup. Put them in the owning todo file,
  not here.
- Stop and reset every profile afterwards (`mise run dev:stop --profile <p>`,
  `mise run dev:reset --profile <p>`). Remove only resources the run created.

## Open questions

- Should a provider that is qualified for a feature be re-qualified after
  every agent SDK or CLI upgrade? [`upgrade-agents.md`](../development/upgrade-agents.md)
  has the bump runbook but no rule for this. The CLI, slash-command and MCP
  todo files each raise the same question.
- Which providers have credentials available for agent-test profiles, and who
  owns the macOS, iOS and two-machine runs?
- Should any of these runs become a scheduled CI job, such as Docker live
  suites on a Docker-capable runner or a macOS runner for Electron?

## Needs verification

- When the host has no `CLAUDE_CONFIG_DIR`,
  `apps/desktop/electron/backend-process.ts` defaults
  `ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR` to `<home>/.claude`. Claude
  then looks for `~/.claude/.claude.json` rather than `~/.claude.json`, so it
  may treat the profile as a first run. Authentication still works through
  `ANTHROPIC_AUTH_TOKEN`. Needs a live check.

## Related

- [test-suite-and-ci-health.md](test-suite-and-ci-health.md) for CI gates and
  slow or flaky suites.
- [mixed-version-compatibility.md](mixed-version-compatibility.md) for
  old-client and old-bridge runs.
- Living-doc drift to fix: the OpenCode paragraph in
  [`agent-testing.md`](../development/agent-testing.md) still says a pinned
  model is required because the shipped default fails, and links a deleted
  note. Since #985 no fixed default ships.

## Replaces

- `docs/2026-10-14/03-startup-claude-login-dialog.md` (left-open items: `PATH`
  fallback in agent-test, the `~/.claude` config-dir default)
- `docs/2026-10-14/04-opencode-fork-loses-model.md` (live check)
- `docs/2026-10-14/07-cleanup-follow-ups.md` (live OpenCode spec run)
- `docs/2026-10-14/terminal-input-recovery-plan.md` (Electron re-run)
- `docs/plans/codex-duplicate-agent-cards.md` (isolated browser workflow)
- `docs/plans/sdk-coverage/02-typed-engine-boundaries-and-drift.md`,
  `03-transcript-part-coverage.md`, `11-usage-cost-and-limits.md`,
  `13-opencode-v1-streaming-and-cleanup.md` and
  `14-acp-bridge-generalization.md` (their remaining browser QA)
