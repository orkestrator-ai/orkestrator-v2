# Container qualification follow-ups

Checked against `main` at `459d2944` plus the 0019 qualification branch
(2026-10-23).

The 2026-10-23 qualification pass for
[0019-container-platform-qualification.md](0019-container-platform-qualification.md)
fixed what it found that was small and in scope. This file holds the gaps it
found but did not fix: misleading failure codes, two provider credential
paths, harness leaks, and one stale activity state. None of them grants an
approval, loses data or weakens a firewall today; each is reported with the
evidence that found it.

## Current state

- A stop that commits through `stopEnvironmentOnce` withdraws the
  environment's outstanding agent requests from the cached projection
  (`withdrawEnvironmentInteractions` in `native-agent-service-prompt.ts`).
  Other paths that leave a runtime stopped do not.
- A restricted boot that fails closed exits at once. The backend's readiness
  poll then usually sees an exited container and reports `container-exited`;
  the exact code (`firewall-missing`, `firewall-failed`) is only in the
  container's last boot record and its log.
- A rebuild copy step that loses the Docker daemon now fails safely (only the
  daemon's "Could not find the file" means absent), but it is reported as a
  verification failure.
- `start_cursor_server` keeps a busy container bridge on its old Cursor key
  until it is idle. The local path does not.

## Outstanding work

### Agent state after a stop

1. Clear or settle a stopped session's turn activity (medium). The per-session
   activity (`observedSessionActivity`) is not cleared on stop: the sweep skips
   environments that are not ready (`native-agent-service-reconciliation.ts:289`)
   and only deletes observations whose mapping changed (`:533-539`). A session
   last seen `waiting` therefore stays `waiting` while stopped. `session get`
   shows `activity: waiting`, `session send` refuses with "busy: waiting for an
   answer" (`public-api/actions-sessions.ts:308-317`), and the run observer now
   reports `running` with no pending request. Decide what a stop does to turn
   activity without firing a false "finished" edge on the next start.
2. Withdraw outstanding requests on the other stop paths (low). A container
   that dies on its own and is found by lifecycle reconciliation, recovery
   copies and replacement leave the last `pending` snapshot until the session
   reattaches.

### Failure classification

3. Keep the specific boot failure code (low). When the container has exited,
   read the final boot record with `docker cp` (it works on a stopped
   container) before falling back to `container-exited`, so the user sees
   "firewall failed" rather than "container exited". Seen in every run of
   `container-live-readiness.test.ts`.
4. Report a daemon outage during a rebuild copy as `daemon-unavailable`
   (medium). Today it is `needs-attention: … failed verification
   (helper-failed|source-read-failed)`, which is safe but sends the user
   looking for corrupt files. `operationFailureCode` also misses the current
   CLI wording `failed to connect to the docker API`, which
   `commands-registry-docker.ts` already matches.
5. Stop misreading a lost daemon as a manifest-less image (medium).
   `copyOutBounded` in `docker-image.ts` treats
   `/could not find the file|no such file|not found/` as "no manifest". If the
   daemon socket disappears between the probe's `docker create` and its
   `docker cp`, the image reads as `legacy`, and `manifestCache` keeps that
   answer for the life of the process. Apply the same strict rule
   `pipeContainerPath` now uses.

### Provider credentials

6. Keep a busy local Cursor bridge on its key (medium). `commands-servers.ts`
   replaces a local Cursor bridge on "Cursor credentials changed" with no
   live-work check, which in a container killed the running turn and wedged
   the session with "already has active run" until the fix in
   `start_cursor_server`. Found by reading the code; not run.
7. Read the Grok login from the profile in agent-test profiles (medium). The
   container Grok staging (`portableInputSpec` `grok-home`) and the push before
   each bridge start (`hostStagingSources().grokAuth`) read the real host
   `~/.grok/auth.json` through `ORKESTRATOR_AGENT_TEST_HOST_HOME`, not the
   profile's restricted snapshot in its isolated home, where Codex and OpenCode
   containers take theirs from. So `grok-container-login.spec.ts` edits a file
   the container never reads, and its `expires_at == 2000-01-01` assertion
   should fail once a live host login exists; the spec has only ever skipped.
   It also means a profile cannot be pointed at a disposable Grok copy, which
   the Grok half of C21 needs.
8. Find out why container bridge logs are missing (low). In both containers of
   the 2026-10-23 rotation run, `/tmp/cursor-bridge.log` and
   `/tmp/claude-bridge.log` were never created although the log writer was
   running, even with `debugLogging` on.

9. Decide whether restricted containers allow `opencode.ai` for OpenCode
   (medium). OpenCode's default providers could not connect in a restricted
   container until the environment's allowlist named `opencode.ai`; the C13
   run added it to that one environment. Adding it to OpenCode's required hosts
   widens egress for every install with OpenCode enabled, and
   `network-allowlist.test.ts` pins OpenCode to no hosts today, so it needs a
   product decision. Users who sign OpenCode in to another provider are not
   affected.
10. Surface a provider's refusal of a turn (medium). When Codex or Pi rejects
    the configured model (the defaults `gpt-5.4` for Codex and `openai/gpt-4`
    for Pi are refused for a ChatGPT-account login), the error reaches neither
    the session nor the transcript, so the turn looks idle with an empty
    reply. That is what the first C13 attempt read as "turns finished with no
    assistant message". Show the refusal, and check whether those defaults
    should change for ChatGPT-account logins.

### Rootless follow-ups

11. Check the global default budget against the daemon when it is saved (low).
   Create refuses it later and the policy view flags it, but Settings accepts a
   default the daemon cannot enforce without saying so.

### Harness

12. Remove live-suite resources one at a time (low). Under load, Docker
    Desktop 4.95 intermittently answered a multi-argument `docker rm -f` or
    `docker volume rm` with `404 page not found`. The lifecycle, network,
    firewall and replacement suites' `afterAll` hooks remove in one call and
    ignore errors, so they can leak silently. The two new suites remove one
    resource at a time and assert nothing is left.
13. In-container setup outlives a killed setup terminal (low). When the
    terminal's host process dies, `workspace-setup.sh` keeps running and holds
    `flock /tmp/orkestrator-workspace-setup.lock`. The backend reports the setup
    failed and reruns nothing (C10 holds), but if the orphan later finishes, an
    explicit retry reports "Workspace already set up" without running setup.
    Decide whether a retry should wait for or stop the orphan, and document it.

## Constraints and rationale

- None of these may grant an approval, run setup twice or weaken a firewall to
  fix a message. Generation death denies or withdraws (AGENTS.md invariant 10).
- Fault injection stays in test fixtures at the lifecycle-service boundary.

## Open questions

- Item 1: should a stop mark the turn `interrupted`, or clear the activity
  and let the reattached session report what it finds?

## Needs verification

- Items 6 and 7 come from reading the code; run them before changing
  behaviour.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md):
  the qualification pass that found these.
- [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md):
  Grok and Cursor credential delivery.
- [Container lifecycle](../../architecture/container-lifecycle.md),
  [container qualification](../../development/container-qualification.md).

## Replaces

Nothing; new work from the 2026-10-23 pass.
