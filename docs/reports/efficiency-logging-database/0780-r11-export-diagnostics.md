# An "Export diagnostics" bundle

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Build the bundle on the backend**: one command gathers content-free diagnostics into a local archive. Status: open.
2. **Settings button with a manifest**: show what will be saved first. Status: open (depends on 1).
3. **CLI command and `--fix` reference**: `orkestrator diagnostics export`, named in the fix prompt. Status: open (depends on 1).

### 1. Build the bundle on the backend

**Problem.** The richest diagnostics are unreachable by users, and a bug report means talking someone through finding files.

**Context.** Since the report, the Bug button and `orkestrator --fix` have grown a shared facts reader (`packages/protocol/src/node/bug-report-facts.ts`), listing log names, sizes and backend descriptor fields, never contents. It does not read metrics. The agent reads the logs directly. The two features differ: a bug report drafts a public issue through an agent, and this is a local file.

**Investigation.** Parts exist: `handleMetrics` (`apps/backend/src/gateway-handlers.ts:337-358`) returns gateway metrics, recurring work, compatibility paths, event-loop and console stats, and `changes_get_diagnostics` (`commands-registry-changes.ts:187`) lists owners and counters. Log sizes come from `get_log_storage_stats`. `/__orkestrator/metrics` has no client UI; the metrics route is `API_PREFIX` plus `/metrics` (`gateway-support-core.ts:195`, `:841`). No export code exists. `tar-stream` is the repo's archive dependency (`package.json:37`), and no zip library is.

**Decisions.**

- **Archive format?**
  - **`.tar.gz` through the existing `tar-stream` (recommended).**
    - Pros: no new dependency; Node gzips it natively.
    - Cons: less friendly than a zip on Windows, which the report's "zip" assumes.
  - **Zip, adding a small dependency.**
    - Pros: opens anywhere with a double click.
    - Cons: a new dependency for one feature.
- **What about the debug log portion?**
  - **Last N MB when saving is on, redacted again with `redactBridgeLogLine`-style rules at export (recommended).**
    - Pros: the report's trade-off names a redaction pass; raw vendor lines are the riskiest content.
    - Cons: export cost on a large log; redaction is not a proof of no content.
  - **Exclude debug logs; rely on the essential log and metrics.**
    - Pros: a very strong content-free claim.
    - Cons: the lines that explain most bugs are missing.
- **Where does the backend read the rest?**
  - **In-process from the same functions `handleMetrics` uses (recommended).**
    - Pros: no gateway or auth path; works standalone.
    - Cons: the snapshot code needs moving behind one function both call.
  - **HTTP to its own `/metrics`.**
    - Pros: guaranteed the same answer as the endpoint.
    - Cons: a loopback call with a credential for no gain.

### 2. Settings button with a manifest

**Problem.** Users should see what a bundle holds before saving it.

**Context.** The report asks for a manifest preview and no upload, matching "nothing leaves the machine".

**Investigation.** Settings → Debug has **Open log folder** and **Clean up logs** (`GlobalSettings.sections.tsx`, near `:2293`). Native save dialogs already exist in `apps/desktop/electron/native-dialogs.ts`.

**Decisions.** None: a two-step command, plan then write, so the manifest is exactly what is written. Web clients receive it as a download.

### 3. CLI command and `--fix` reference

**Problem.** Headless hosts need it too, and the fix prompt should say it exists.

**Context.** `packages/cli/src/client/fix.ts` grants the agent read access to the logs directory only (`:56-58`).

**Investigation.** `packages/cli/src/client/argv.ts` has no `diagnostics` command. `docs/architecture/public-cli.md` governs new surface, and AGENTS.md asks for the docs to move with it.

**Decisions.**

- **How does `--fix` use it?**
  - **Mention it in the prompt as something the user can attach, with no automatic run (recommended).**
    - Pros: a user keeps control; no change to what the agent can read.
    - Cons: relies on the agent and user acting on it.
  - **Run it and hand the agent the bundle.**
    - Pros: richer reports by default.
    - Cons: widens what the agent reads before a public issue is drafted.

## Constraints and rationale

- It must reuse the content-free rules; logs and metrics never hold prompts, tokens or file contents.
- Some contents do not exist yet: the essential log ([0750](0750-r6-essential-event-log.md)) and DB metrics ([0810](0810-r19-database-observability.md)). Build the bundle to include what exists and name the rest in the manifest as absent.
- Effective log policy comes from `resolveLogDetail`; include names and levels only.

## Related

- [Logging and database report, R11](../2026-10-29-logging-and-database-efficiency.md#r11-export-diagnostics-bundle-m2-l7) and [the metrics findings, M2](../2026-10-29-logging-and-database-efficiency.md#metrics-and-diagnostics-findings)
- [Report a bug](../../architecture/bug-report.md)
- [0017 CLI command surface](../../todo/cli-and-slash-commands/0017-cli-command-surface.md), which does not cover this command
- [0740](0740-r6-docker-bridge-log-rotation.md), [0820](0820-r12-rolling-health-summary.md)
