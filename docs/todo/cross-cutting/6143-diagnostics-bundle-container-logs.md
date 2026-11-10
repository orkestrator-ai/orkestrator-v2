# Container bridge logs in diagnostics

## Task analysis

Analysed 2026-11-05 against `main` at `ecff91f74`. From E15 parts `0780` and `0750`.
Done 2026-11-10 on a branch from `04639b12b`.

### Tasks

1. **Decide whether the bundle carries container server logs**: and redact them if so. Status: done (opt-in per environment).
2. **A container bridge's essential events**: its `session.resume-fell-back` never reaches the essential log. Status: done (answered by task 1).

### 1. Decide whether the bundle carries container server logs

**Problem.** A bug in a Docker environment is often explained by its bridge's log, and E14 named the export as the first consumer of `getContainerServerLog`. The bundle names these logs as not collected.

**Context.** `getContainerServerLog` in `apps/web/src/lib/backend/docker-skills.ts` reads every container server's log and, with `previous`, the run before its last relaunch. The backend has the same read behind its commands. No UI calls it yet.

**Investigation.** Each read is a `docker exec` per server in each running container, so the cost grows with the machine's environments and a stopped container answers nothing. The lines are raw provider output, the riskiest content a bundle could hold, and this is the part that most needs the "redaction is not a proof" warning. The redaction test covers the formats E15 was asked about, not a corpus of provider output.

**Decisions.**

- **Should a bundle read them?**
  - **Offer them per environment, as an opt-in in the Export dialog, bounded per server and redacted by the same pass (recommended).**
    - Pros: the user chooses the risk and the cost; a bug in one environment needs only that one.
    - Cons: the plan gains an argument, and the manifest's "exactly what is written" has to hold per choice.
  - **Include every running container's logs by default.**
    - Pros: most complete; no choice to make.
    - Cons: a `docker exec` per server on every export, and the most sensitive content by default.
  - **Leave them out.**
    - Pros: the strongest claim about content; the user can still attach one by hand.
    - Cons: E14's reader stays unbuilt, and Docker bugs need another step.

### 2. A container bridge's essential events

**Problem.** A container bridge's resume fallback is an essential event that the essential log never holds.

**Context.** A local bridge's lines reach the essential log over the relay. A container bridge has no such hop, so `session.resume-fell-back` stays in the container's own server log. E15's part `0750` recorded this as out of its work.

**Investigation.** The event is still written inside the container only. The transcript note that tells the user a new conversation started (`appendResumeFallbackNotice`) works there, so what is missing is the after-the-fact evidence, not the user's notice.

**Decisions.**

- **How does it reach the evidence?**
  - **Answer it with task 1: a container's bundled log, read on request, holds the line (recommended).**
    - Pros: one read path; no new traffic while nothing is being investigated.
    - Cons: the line is gone once the log rotates past it.
  - **The backend tails each container's log into the essential log.**
    - Pros: the line survives in one place.
    - Cons: continuous work per container for a rare event.

## Current state

Done, with the recommended design. A plan now answers with the machine's container
environments (`containerLogs` on `DiagnosticsBundlePlan`). The Export dialog lists them
under "Container server logs (optional)", none ticked; **Rebuild with these logs**
plans again through the new admin command
`plan_diagnostics_bundle_with_container_logs` (at most 8 environments), and the
manifest shown is always that new plan's. For each chosen environment
`apps/backend/src/core/diagnostics-container-logs.ts` runs one `docker exec` to list
the servers that have written a log, then one bounded tail per log (current run and
`*.prev.log`), scrubbed by `boundDiagnosticTail` and then by the bundle's own redactor
and credential check. They are written as `logs/containers/<environmentId>/<file>`.
An environment that is gone, has no container, is not running or does not answer is
named as absent with its reason. Documented in
[logging.md](../../architecture/logging.md#the-diagnostics-bundle).

Not offered: the public `diagnostics.plan` action and `orkestrator diagnostics export`
still build the bundle without container logs (their manifest names them as not
chosen). The to-do asked for the Export dialog; adding a CLI option would change the
public API contract and can follow if someone asks for it. The read path has not been
run against a real container in this build: it was proved with a fake Docker reader,
and the command and dialog with focused tests. The `docker exec` and tail commands are
the ones the existing `get_<provider>_server_log` commands already run.

## Assumptions and decisions

### Task 1: an argument or a command

`plan_diagnostics_bundle` took no arguments, and its empty argument schema accepts any
value, including a non-object; the contract CI's argument fixtures refuse a change that
narrows that for releases in the support window. So the choice is a new admin command,
`plan_diagnostics_bundle_with_container_logs`, rather than an optional argument. This
also makes an older backend answer `unknown-command` (shown as the machine's update
notice) instead of silently building a bundle without the logs the user ticked. The
alternative, bumping the `system` domain, would need an adapter and a register row for
one optional field.

### Task 1: one plan per choice

A plan already building is joined only by a request for the same choice (the sorted
environment ids), so two dialogs choosing differently never receive each other's
bundle. The dialog rebuilds the plan rather than adding files to it, which keeps
"the manifest is what is written" true for every choice.

### Task 1: bounds and cost

Each log is bounded at the source by the existing container tail bound (64 KiB and 200
lines), so a chosen environment adds at most 12 such tails; at most 8 environments can
be chosen. Files that are empty are not read, because one `docker exec` lists which
exist first. Environments are read side by side, their files one at a time, each exec
with a 15 s timeout.

### Task 2: how the event reaches the evidence

The recommended option: answered by task 1. A container bridge writes JSON lines to its
log file, and a chosen environment's bundled log holds its `session.resume-fell-back`
line; a test writes that record into a fake container log and finds it in the archive.
Nothing tails containers continuously, so the line is gone once the log rotates past
it, the cost the decision named.

## Related

- [The diagnostics bundle](../../architecture/logging.md#the-diagnostics-bundle)
- Closing check of E14 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)
