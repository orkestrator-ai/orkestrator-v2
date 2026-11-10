# Input stamp follow-ups

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3`.

What the input stamps (to-do 1202 task 15 (retired 2026-11-10), DK-14) left. See [Input stamps](../../architecture/container-lifecycle.md#input-stamps-staged-inputs5).

### Tasks

1. **A Claude copy the backend pushed after a host sign-out**: remove it at the next start rather than stripping it. Status: open.
2. **The relay still copies on every boot**: skip `relay_staged_inputs` work for an unchanged mount. Status: open.

### 1. A Claude copy the backend pushed after a host sign-out

**Problem.** After a host signs out of Claude, a container whose `.credentials.json` was pushed by the backend keeps it until the access token expires (about eight hours), with its refresh tokens stripped.

**Context.** The stamp removes only a login that is still byte for byte what the entrypoint imported. Codex and Grok have their own sign-out paths in the backend (`buildDropImportedLoginCommand`); Claude has none for the host's own login, only for added accounts.

**Investigation.** `syncContainerClaudeLoginUnlocked` in `apps/backend/src/core/agent-accounts-containers.ts` calls `restrictClaudeLogin` when it has nothing usable to push, so the copy stays. That is the same before and after the stamps. The entrypoint cannot decide this itself: on macOS the staged file is usually absent or stale beside the Keychain login, so its absence does not mean a sign-out, and `pushedClaudeLogin` could stop the backend pushing a removed login back. Not reproduced on a real sign-out; this comes from reading the code and from the stamp tests' fixture of a later push.

**Decisions.**

- **Where should the removal go?**
  - **In the backend's sync, when the host reads as signed out rather than expired or unreadable (recommended).**
    - Pros: the backend knows the Keychain and account state, and already tells these apart for Codex and Grok (`hostSignedOut`).
    - Cons: needs a Claude reading of "signed out" that is reliable on macOS, where a `security` failure must not count.
  - **Leave it.**
    - Pros: no risk of signing a container out on a misread; the token lapses on its own.
    - Cons: the access token stays usable for up to eight hours after the sign-out.

### 2. The relay still copies on every boot

**Problem.** Where `node` cannot read the staged mounts (rootless Docker, or a rootful daemon whose host user is not uid 1000), `relay_staged_inputs` streams each mount with `tar` on every boot, unchanged or not.

**Context.** The stamps skip the copy into the home, not this one. The relay lives in root's entrypoint and writes `node`'s `/run/orkestrator-inputs`, which is rebuilt on purpose so that an emptied revision is empty at the next start.

**Investigation.** Not measured. This host's daemon is rootful with uid 1000, so the relay does not run here; the unit tests exercise a rebuilt relay against the stamps, and the real container check did not cover it. `/run` is a tmpfs in some setups, so there may be no earlier copy to compare with.

**Decisions.**

- **What to do about it?**
  - **Measure on a rootless daemon first, and leave the relay as it is until that shows a cost (recommended).**
    - Pros: the relay's rebuild is what makes revocation simple; `tar` to a tmpfs may be cheap compared with what the home copy cost.
    - Cons: the saving stays smaller on those daemons until then.
  - **Compare digests in the root entrypoint before relaying.**
    - Pros: saves the same work on those daemons.
    - Cons: adds a root step that reads `node`-owned state, which has to meet the rules in `docker/AGENTS.md`.

## Needs verification

- The relay's cost on a real rootless daemon, and the stamps with a real relay there. The live test (`apps/backend/tests/portable-inputs-stamps-docker.test.ts`) runs in the "Container live qualification" workflow, whose runner has a non-1000 host user, so the next run of it on a pull request should show the second.

## Related

- to-do 1202 efficiency follow-ups, task 15 (retired 2026-11-10).
- Closing check of E25 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), which replaced the 0490 Container start report.
- [6740 input staging follow-ups](6740-input-staging-follow-ups.md).
- [0018 container network and credential isolation](0018-container-network-and-credential-isolation.md).
