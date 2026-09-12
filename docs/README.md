# Documentation catalog

`AGENTS.md` is the agent source of truth. This file is the living catalog of
`docs/` only — status, location, and which document to open. Do not copy
invariants from `AGENTS.md` here.

Refreshed 2026-09-12 against the current tree.

## Status legend

| Status | Meaning |
| --- | --- |
| Living | Current operator or architecture guide. Keep aligned with the tree. |
| Active | Work still in progress. Pick from here, not from a snapshot. |
| Done | Shipped. Kept as the original plan; the living product doc is linked. |
| Deferred | Intentionally not started. Read the header before treating it as a backlog. |
| Historical | Dated snapshot or incident record. Do not pick work from it. |

## Architecture

| Document | Status | Notes |
| --- | --- | --- |
| [agent-engines.md](architecture/agent-engines.md) | Living | Six-engine architecture. Coordinator tiers match `coordinator-providers.ts`. |
| [coordinator.md](architecture/coordinator.md) | Living | Product coordinator guide: unassigned-first conversations, delegation, read-only checkout. |
| [control-mcp.md](architecture/control-mcp.md) | Living | Control MCP operator guide. |
| [remote-gateway.md](architecture/remote-gateway.md) | Living | Standalone backend, Tailscale Serve, flags, troubleshooting. |
| [review-preparation.md](architecture/review-preparation.md) | Living | Multi-review pipeline; queue wait is 30 minutes. |
| [bridge-diagnostics.md](architecture/bridge-diagnostics.md) | Living | Shared bridge debug logging. |
| [cursor-usage.md](architecture/cursor-usage.md) | Living | Cursor usage mapping. |
| [cursor-diagnostics.md](architecture/cursor-diagnostics.md) | Historical | 2026-09-09 stall incident. Current logging is in `bridge-diagnostics.md`. |
| [platform-inconsistencies.md](architecture/platform-inconsistencies.md) | Historical | 2026-08-16 inventory plus a 2026-09-11 current-state note. Not a backlog. |

## Development

| Document | Status | Notes |
| --- | --- | --- |
| [testing-guide.md](development/testing-guide.md) | Living | How to choose and run tests. Commands live here. |
| [agent-testing.md](development/agent-testing.md) | Living | Isolated profiles and real-stack QA. |
| [upgrade-agents.md](development/upgrade-agents.md) | Living | SDK/CLI bump runbook. Pins are test-enforced. |
| [flaky-tests.md](development/flaky-tests.md) | Living | Only flake registry. Do not start a second one. |
| [credentials-and-models.md](development/credentials-and-models.md) | Living | Credential and catalogue inventory. |
| [test-logs.md](development/test-logs.md) | Living | Diagnostic-bounds rationale. Operator commands stay in `testing-guide.md`. |

Steer probe scripts live in [`scripts/steer-probes/`](../scripts/steer-probes/), not under `docs/`.

## Plans

| Document | Status | Notes |
| --- | --- | --- |
| [sdk-coverage/00-index.md](plans/sdk-coverage/00-index.md) | Active | Living index. 01–03 Done; 04–10 and 14–15 Active; 11–13 code done, QA leftover. |
| [coordinator-implementation-plan.md](plans/coordinator-implementation-plan.md) | Done | Original landing-page plan. Product doc is `architecture/coordinator.md`. |
| [coordinator-all-providers.md](plans/coordinator-all-providers.md) | Done | Multi-provider tiers shipped. Product doc is `architecture/coordinator.md`. |
| [async-coordinator.md](plans/async-coordinator.md) | Done | Fire-and-finish plus one-wake batching shipped 2026-09-08. |
| [codex-duplicate-agent-cards.md](plans/codex-duplicate-agent-cards.md) | Done | Automated verification landed; isolated browser QA still pending. |
| [sdk-coverage-2026-09-06.md](plans/sdk-coverage-2026-09-06.md) | Historical | Source review for the SDK plans. Do not pick work from this file. |

## Todos

These are the only unfinished `docs/todo/` files.

| Document | Status | Notes |
| --- | --- | --- |
| [opencode-v2.md](todo/opencode-v2.md) | Deferred | Session v2 is unused. Production stays on the legacy `client.session.*` API. Pin is `1.18.29`. |
| [remote-stream-compression.md](todo/remote-stream-compression.md) | Deferred | Measure redundant payloads before changing compression defaults. |
| [remote-client-data-saving-mode.md](todo/remote-client-data-saving-mode.md) | Deferred | Proposal only. Measure existing incremental reads first. |
