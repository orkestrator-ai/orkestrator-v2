# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

One React interface (`apps/web`) runs as the Electron desktop renderer (`apps/desktop`), in authenticated remote browsers, and inside the iOS app (`apps/ios`), a SwiftUI shell around the responsive web UI in a `WKWebView`. The native iOS surfaces are the saved-server picker, credential entry, the failure screen and the privacy cover. The public site (`apps/web-public`) is a static web page.

## Users

Primarily an experienced individual developer on their own machine or machines. They run several coding agents in parallel (Claude Code, Codex, OpenCode, Cursor Agent, Grok Build, Pi), delegate through a project Coordinator and build pipelines, and check in from a browser or iPhone over a private network (Tailscale) while work continues in the background.

Small engineering teams working on shared repositories, each member with their own backend, are a secondary audience.

## Product Purpose

Orkestrator runs coding agents under explicit control. It creates isolated development environments (Docker containers or local Git worktrees) per task, each with its own checkout and branch. It then moves the work through graphs: build, validate, independent multi-reviewer review, fixes, verification and the pull request. Success means a developer can hand off many tasks, switch away, and come back to reviewed, evidence-backed pull requests without any agent having written outside its environment.

## Positioning

Two claims carry equal weight and form one argument: **every agent in a sealed container, every change through a review graph.** Agents can work unattended because they are contained (per-environment Docker runtime and network, allowlist firewall, backend-resolved execution policy, approvals that deny on timeout) *and* because their output is reviewed (sealed evidence packages, Multi Review fan-out, pipelines that end in a PR). Everything runs on the user's own machine. The public site only serves static files; commands, terminals and agent sessions never pass through it.

## Operating Context

- Desktop app on macOS or Linux, with the backend running locally as a Bun service. Remote access goes through the gateway's browser client and the iOS app over Tailscale HTTPS, with a gateway token.
- A project holds a project home (the canonical checkout), prompt environments (interactive, run a prompt; review and PR are started separately) and pipeline environments (build, review, fix, verify, open the PR and resolve conflicts on their own).
- Each project has one read-only Coordinator conversation that inspects the checkout and launches workers, which report back over durable agent mail. Side agents discuss but do not launch.
- Long-running work (sessions, terminals, mail, pipelines, schedules) lives in the backend and continues while another environment is on screen. The UI rehydrates from authoritative snapshots.
- The work happens alongside the developer's own tools: GitHub pull requests, terminals, diffs, Kanban tickets, browser previews and the `orkestrator` CLI.

## Capabilities and Constraints

- Agent platforms: Claude Code, Codex, OpenCode, Cursor Agent, Grok Build, Pi, in native (rich transcript) and terminal modes.
- Core features: environments (container or worktree), Coordinator, build pipelines, Multi Review, graphs, goals, suborks, scheduled jobs, agent mail, approvals/interactions, tickets, transcript artifacts, browser previews, federation across machines, public CLI.
- Safety constraints the UI must never misrepresent: approvals deny on timeout, disconnect or unparseable answers; closing a tab never deletes a conversation; the Coordinator cannot edit the checkout; a restricted network limits destinations, not what is sent; host sessions default to no vendor sandbox.
- Terminology to keep: project home, prompt environment, pipeline environment, Coordinator, side agent, worker, Multi Review, build pipeline, execution policy, agent mail, subork.
- Current version is 2.37.1-beta.
- Undecided: licence and distribution terms (no LICENSE file), pricing (none exists).

## Brand Commitments

- Name: **Orkestrator** (the package is `orkestrator-ai`; the CLI is `orkestrator`).
- Logo sources: `logos/ork-logo.png`, `logos/ork-logo2.png` and their `.afdesign` masters.
- Voice: plain, precise, factual British English. Claims are stated as mechanisms ("Isolation is the default, not a setting."), limits are stated honestly (what the firewall does not stop), and nothing is promised that the system does not enforce.

## Evidence on Hand

- Public beta, distributed with an install command for macOS and Linux.
- Real product mechanics documented in `README.md` and `docs/architecture/`. These are the only proof material.
- No testimonials, customer names, usage metrics, benchmarks, pricing or licence terms exist. Future work must not invent any.

## Product Principles

1. **Contained by default.** Isolation and denial are the starting state; widening access is an explicit, visible choice.
2. **Show the mechanism, not a promise.** Surfaces explain what the system enforces and where its limits are.
3. **Work outlives the screen.** Nothing the user starts depends on a view staying open; every view can recover the true state.
4. **Evidence before trust.** Agent output arrives with its validation, review findings and provenance attached.
5. **The developer stays in charge.** Agents propose and run; humans approve, merge and delete.
