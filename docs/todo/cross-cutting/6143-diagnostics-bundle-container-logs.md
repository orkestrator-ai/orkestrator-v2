# Container bridge logs in diagnostics

## Task analysis

Analysed 2026-11-05 against `main` at `ecff91f74`. From E15 parts `0780` and `0750`.

### Tasks

1. **Decide whether the bundle carries container server logs**: and redact them if so. Status: open.
2. **A container bridge's essential events**: its `session.resume-fell-back` never reaches the essential log. Status: open (depends on 1).

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

## Related

- [The diagnostics bundle](../../architecture/logging.md#the-diagnostics-bundle)
- [Closing check of E14](../../reports/efficiency-logging-database/0000-index.md#closing-check-of-e14-docker-logs)
