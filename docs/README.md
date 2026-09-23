# Documentation catalog

`AGENTS.md` is the agent source of truth. This file is the living catalog of
`docs/` only — status, location, and which document to open. Do not copy
invariants from `AGENTS.md` here.

Refreshed 2026-09-17 against the current tree.

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
| [coordinator.md](architecture/coordinator.md) | Living | Current Coordinator: ownership, tiers, async delegation, MCP actions. Remaining work is `todo/coordinator-to-implement.md`. |
| [design-canvas.md](architecture/design-canvas.md) | Living | HTML/CSS canvas, revisions, design MCP and .orkdes files. |
| [control-mcp.md](architecture/control-mcp.md) | Living | Control MCP operator guide. |
| [mcp-management.md](architecture/mcp-management.md) | Living | Per-provider MCP server management: sources, precedence, safe writes, secrets, apply states, evidence. |
| [remote-gateway.md](architecture/remote-gateway.md) | Living | Standalone backend, Tailscale Serve, flags, troubleshooting. |
| [browser-previews.md](architecture/browser-previews.md) | Living | Service previews: registry, desktop tunnel, private HTTPS origins, relay, kill switch, rollback. |
| [review-preparation.md](architecture/review-preparation.md) | Living | Multi-review pipeline; queue wait is 30 minutes. |
| [native-agent-commands.md](architecture/native-agent-commands.md) | Living | Slash-command descriptors, bridge wire contract, intent resolution, collisions, catalogue lifecycle. |
| [bridge-diagnostics.md](architecture/bridge-diagnostics.md) | Living | Shared bridge debug logging. |
| [cursor-usage.md](architecture/cursor-usage.md) | Living | Cursor usage mapping. |
| [cursor-diagnostics.md](architecture/cursor-diagnostics.md) | Historical | September 9 and 14 stall investigations. Current logging is in `bridge-diagnostics.md`. |
| [platform-inconsistencies.md](architecture/platform-inconsistencies.md) | Historical | 2026-08-16 inventory plus a 2026-09-11 current-state note. Not a backlog. |

## Development

| Document | Status | Notes |
| --- | --- | --- |
| [testing-guide.md](development/testing-guide.md) | Living | How to choose and run tests. Commands live here. |
| [agent-testing.md](development/agent-testing.md) | Living | Isolated profiles and real-stack QA. |
| [upgrade-agents.md](development/upgrade-agents.md) | Living | SDK/CLI bump runbook. Pins are test-enforced. |
| [credentials-and-models.md](development/credentials-and-models.md) | Living | Credential and catalogue inventory. |
| [test-logs.md](development/test-logs.md) | Living | Diagnostic-bounds rationale. Operator commands stay in `testing-guide.md`. |

## Tests

| Document | Status | Notes |
| --- | --- | --- |
| [0000-index.md](tests/flaky-tests/0000-index.md) | Living | Only flake registry index. Search it; open a case file only when the row matches. |

Steer probe scripts live in [`scripts/steer-probes/`](../scripts/steer-probes/), not under `docs/`.

## Reviews

| Document | Status | Notes |
| --- | --- | --- |
| [2026-09-22-platform-version-audit.md](reviews/2026-09-22-platform-version-audit.md) | Historical | Compatibility and feature audit for the 2026-09-22 platform version refresh. |
| [2026-09-17-platform-version-audit.md](reviews/2026-09-17-platform-version-audit.md) | Historical | Compatibility and feature audit for the 2026-09-17 platform version refresh. |

## Plans

| Document | Status | Notes |
| --- | --- | --- |
| [sdk-coverage/00-index.md](plans/sdk-coverage/00-index.md) | Active | Living index. 01–03 Done; 04–10 and 14–15 Active; 11–13 code done, QA leftover. |
| [improvements/browser/plan/00-index.md](improvements/browser/plan/00-index.md) | Active | Browser preview plan. 01–13 implemented behind disabled-by-default capabilities; 14–15 partly evidenced. Browser, Safari/iOS, two-machine, and Docker Desktop runs are outstanding. |
| [mcp/plan/00-index.md](improvements/mcp/plan/00-index.md) | Active | MCP server management plan. Steps 02–12 implemented; container-private writes (13) and live-probe/real-stack evidence (01, 14) outstanding. Findings: [mcp.md](improvements/mcp.md). |
| [slash-commands/plan/00-index.md](improvements/slash-commands/plan/00-index.md) | Active | Slash-command correctness plan. Code landed; live provider probes and isolated browser QA are the open items. Findings: [slash-commands.md](improvements/slash-commands.md). |
| [codex-duplicate-agent-cards.md](plans/codex-duplicate-agent-cards.md) | Done | Automated verification landed; isolated browser QA still pending. |
| [sdk-coverage-2026-09-06.md](plans/sdk-coverage-2026-09-06.md) | Historical | Source review for the SDK plans. Do not pick work from this file. |

## Todos

These are the only unfinished `docs/todo/` files.

| Document | Status | Notes |
| --- | --- | --- |
| [coordinator-to-implement.md](todo/coordinator-to-implement.md) | Active | Coordinator read-only adapters, turn-control gaps, and one live suite. |
| [opencode-v2.md](todo/opencode-v2.md) | Deferred | Session v2 is unused. Production stays on the legacy `client.session.*` API. Pin is `1.18.32`. |
| [remote-stream-compression.md](todo/remote-stream-compression.md) | Deferred | Measure redundant payloads before changing compression defaults. |
| [remote-client-data-saving-mode.md](todo/remote-client-data-saving-mode.md) | Deferred | Proposal only. Measure existing incremental reads first. |
