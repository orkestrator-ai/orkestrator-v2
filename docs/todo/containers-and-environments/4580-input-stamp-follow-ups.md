# Input stamp follow-ups

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766` (first analysed 2026-11-04 at `96ee1eb3`).

What the input stamps (to-do 1202 task 15 (retired 2026-11-10), DK-14) left. See [Input stamps](../../architecture/container-lifecycle.md#input-stamps-staged-inputs5).

### Tasks

1. **A Claude copy the backend pushed after a host sign-out**: remove it at the next start rather than stripping it. Status: done (2026-11-11).
2. **The relay still copies on every boot**: measure what it costs. Status: done (2026-11-11).
3. **Skip relaying an unchanged mount**: the measurement in task 2 shows a cost, so build the skip. Status: open.
4. **The macOS half of task 1's sign-out reading**: confirm `security`'s exit status on a Mac. Status: open.

### 1. A Claude copy the backend pushed after a host sign-out

**Problem.** After a host signs out of Claude, a container whose `.credentials.json` was pushed by the backend kept it until the access token expired (about eight hours), with its refresh tokens stripped.

**Context.** The stamp removes only a login that is still byte for byte what the entrypoint imported. Codex and Grok have their own sign-out paths in the backend (`buildDropImportedLoginCommand`); Claude had none for the host's own login, only for added accounts.

**Investigation.** `syncContainerAgentAccountsOnStart` in `apps/backend/src/core/agent-accounts-containers.ts` called `restrictClaudeLogin` whenever the host had nothing usable to push. Done 2026-11-11: when the host login reads as signed out (`hostClaudeSignedOut` in `claude-host-credentials.ts`), the start runs `buildDropHostClaudeLoginCommand` instead, which removes every host copy, keeps a login the container made itself (`claudeAiOauth` or an `mcpOAuth` server, refresh token stripped, as before), deletes a file left with no login and forgets the pushed digest. A login the container made is one that still holds a refresh token or, once stripped, one whose access-token digest the strip recorded in `.credentials.json.orkestrator-owned`, so repeated starts keep it (review fix, 2026-11-11). If `flock` or the locked pass fails, the drop falls back to the restrict command's strip-only pass instead of deleting the file. An expired or unreadable host login still only strips. The reading looks where the pushed login is read from (`runtimeHostClaudeLookup` in `commands-files.ts`) and says "signed out" only when every `.credentials.json` there is absent or holds no login and, on macOS, every Keychain lookup is a metadata-only `security find-generic-password` (no `-w`, so no access prompt) that exits 44, item not found. Tests: `claude-host-credentials.test.ts` (Linux files, macOS with a fake lookup, `probeKeychainItemCommand` against a fake `security` for exit 0, 44, 50, 51 and a timeout) and `agent-accounts-containers-claude-sign-out.test.ts` (the start path for an absent, an emptied, an expired and an unreadable host login, the branch order when host Claude credentials are off or an added account was used, the forgotten digest, and the in-container command against real files: repeated drops, a login the restrict command already stripped, a recorded entry replaced by a host copy, a container-made subscription login and the strip-only fallback when `flock` fails; the block runs only where util-linux `flock` is installed). The live case "official in-image Node merges, restricts and drops real credential paths" in `apps/backend/tests/container-login-security-live.test.ts` now also runs the drop command with the image's own Node and `flock`; it passed on beelink against `orkestrator-v2:qual-0019-498b6876` (built from `498b68766`). Not run against a real host sign-out: no real login may be used here (7568).

**Decisions.**

- **Where should the removal go?**
  - **In the backend's start sync, when the host reads as signed out rather than expired or unreadable (recommended, built).**
    - Pros: the backend knows the Keychain and account state, and already tells these apart for Codex and Grok (`hostSignedOut`).
    - Cons: needs a Claude reading of "signed out" that is reliable on macOS; task 4 confirms its one platform assumption.
  - **Leave it.**
    - Pros: no risk of signing a container out on a misread.
    - Cons: the access token stays usable for up to eight hours after the sign-out.

### 2. The relay still copies on every boot

**Problem.** Where `node` cannot read the staged mounts (rootless Docker, or a rootful daemon whose host user is not uid 1000), `relay_staged_inputs` streams each mount with `tar` on every boot, unchanged or not.

**Context.** The stamps skip the copy into the home, not this one. The relay lives in root's entrypoint and writes `node`'s `/run/orkestrator-inputs`, which is rebuilt on purpose so that an emptied revision is empty at the next start.

**Investigation.** Measured 2026-11-11 on beelink (Linux 7.1.8, load average 43–58 from other builds the whole time, so compare within a row, not with E25's quiet-host figures). Fixtures as E25's (`apps/backend/scripts/portable-input-staging-costs.ts`): `medium` (5,202 files, 65 MiB staged, 6,492 relayed entries) and `plugins` (1,322 files, 300 MiB, 1,476 entries). A throwaway script (`output/efficiency/scripts/input-starts.ts`, not committed) staged each fixture with `stagePortableInputs`, created a `--network none` container of `orkestrator-v2:qual-0019-498b6876` with `stagedInputMountArguments`, bind-mounted copies of both entrypoints with timing lines added, and started it four times, waiting with `waitForContainerBoot`. Rootful: the host daemon (Engine 29.9.2, through the qualification shim) with the revision chowned to 12345 for each start, as `portable-inputs-stamps-docker.test.ts` forces the relay. Rootless: a `mise run docker:disposable` daemon (slirp4netns, containerd image store), where the relay runs on its own. Restarts 1–3, so the stamps copied nothing:

| Daemon | Fixture | Relay | Stamped import | Restart, start to boot | Same, no relay (rootful, uid 1000) |
| --- | --- | --- | --- | --- | --- |
| Rootful, owner 12345 | `medium` | 1,266–1,844 ms | 889–1,380 ms | 4,114–5,131 ms | 1,813–2,973 ms |
| Rootful, owner 12345 | `plugins` | 790–1,150 ms | 778–1,324 ms | 2,912–3,876 ms | 1,388–1,964 ms |
| Rootless | `medium` | 952–1,054 ms | 674–1,373 ms | 2,265–3,123 ms | n/a |
| Rootless | `plugins` | 813–937 ms | 693–1,720 ms | 2,271–3,164 ms | n/a |

The relay takes about as long as the whole stamped import, or longer, on every restart, and roughly doubles a rootful restart where it runs. `/run` was not a tmpfs in either container, so a previous relay copy was there to compare with.

**Decisions.**

- **What to do about it?**
  - **Measure on a rootless daemon first, and leave the relay as it is until that shows a cost (recommended, done).**
    - Pros: the relay's rebuild is what makes revocation simple.
    - Cons: the saving waited for the measurement.
  - **Compare digests in the root entrypoint before relaying.** Now task 3.

### 3. Skip relaying an unchanged mount

**Problem.** Task 2's measurement: on rootless and non-1000 rootful daemons the relay costs about 0.8–1.8 s per restart (under heavy host load), as much as or more than everything else the stamps leave.

**Context.** `relay_staged_inputs` in `docker/network-policy-entrypoint.sh` runs as root, removes `/run/orkestrator-inputs` and re-extracts each unreadable mount as `node`. The rules for root reading or deciding on anything `node` can write are in [`docker/AGENTS.md`](../../../docker/AGENTS.md). The backend rewrites a revision in place before every start (the logins) and on a revocation's scrub, and the revocation also deletes the relayed paths in a running container (`stagedInputRelayPaths`).

**Investigation.** Not built in this pass: it changes root's entrypoint, so it needs a root-boundary review, an image build and a rootless and non-1000 live run of `portable-inputs-stamps-docker.test.ts` (forced relay) plus the revocation cases. The digest has to come from the read-only source mount, never from the relayed copy, which `node` owns.

**Decisions.**

- **How to tell that a mount is unchanged?**
  - **Root hashes the source mount (paths, types, modes and content digests, as `agent_input_manifest` does) and compares it with a digest root kept from the last relay, in a root-only file outside `node`'s reach; equal and the relayed directory still present means skip that mount (recommended).**
    - Pros: root reads only the backend-staged, read-only mount, as `tar` already does; a mount that changed, emptied or disappeared is relayed or removed as now; a `node` that edits its relayed copy only feeds itself different input, which the home stamps then copy.
    - Cons: still reads every byte of the mount; saves the write and the `node`-side extraction, not the read.
  - **Compare metadata only (inode, size, nanosecond mtime).**
    - Pros: no content read, so the largest saving.
    - Cons: trusts that every backend rewrite changes those fields, which the stamps deliberately do not assume.
  - **Leave it.**
    - Pros: no change to root's entrypoint.
    - Cons: keeps the cost measured in task 2 on every restart of those daemons.

### 4. The macOS half of task 1's sign-out reading

**Problem.** Task 1 counts a Mac as signed out only when `security find-generic-password -s <service>` (no `-w`) exits 44 for every keychain it searches. That exit status was taken from `security`'s documented errSecItemNotFound mapping and tested against a fake; it was not run on a Mac, because beelink is Linux.

**Context.** Any other status, a timeout included, keeps the old strip, so a wrong assumption can only make the removal not happen, never sign a signed-in container out. An agent-test profile pins the lookup to its own `login.keychain-db`, so a missing keychain file must not read as "not found".

**Investigation.** Not run. On a Mac node an agent can check it without any real login: create a throwaway keychain with `security create-keychain`, look up a service it lacks with and without the keychain path, add a generic password and look it up again, then delete the keychain. Whether Claude Code's own `/logout` deletes the Keychain record (rather than emptying it) needs a real login, and is in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) (4580 task 4).

**Decisions.**

- **What if a missing pinned keychain file also exits 44?**
  - **Make the agent-test lookup require the keychain file to exist before counting a 44 (recommended if it does).**
    - Pros: keeps "nowhere to look" from reading as signed out.
    - Cons: one more stat in the reading.
  - **Accept it.**
    - Pros: no change.
    - Cons: an agent-test profile on a Mac whose isolated home has no keychain would remove the host copy from its own containers at every start.

## Assumptions and decisions

### Task 1: removal at start only

The removal runs on the container start path, as the task asked, not in the login keeper's five-minute pass, which keeps stripping when it has nothing to push. A running container therefore keeps the stripped copy until its next start; the keeper path would need the same signed-out reading per pass, which is a `security` call per pass on macOS.

### Task 1: what the drop keeps

A backend push never carries a refresh token, so an entry with one, `claudeAiOauth` or an `mcpOAuth` server, was made inside the container (or is a pre-access-only copy the start would have stripped anyway). It stays, but loses the refresh token exactly as the existing strip would have done. Stripping erases that sign, so the strip records the entry first: the restrict and drop commands write `.credentials.json.orkestrator-owned` beside the credential, mapping each kept slot to the SHA-256 digest of its access token (never a token), before rewriting the credential. A later drop keeps an access-only entry whose digest matches and removes every other access-only entry as the host's copy; a push that replaces the entry changes its access token, so the record no longer matches. A file left with nothing is removed. A host that never signed in reads as signed out too, which is safe because the container's own logins are kept by this rule.

The first version deleted `claudeAiOauth` unconditionally, stripped refresh tokens without recording them (so the second start after a sign-out deleted the container's own MCP login), and removed the whole file when `node` or `flock` failed. Review found all three. When the locked pass fails now the drop runs the restrict command's strip-only pass, which keeps every access token and still leaves no refresh token; only if `node` itself cannot read the file does that pass remove it, as it always has.

### Task 2: forced relay on the rootful daemon

The non-1000 rootful case was reproduced by chowning the staged revision to 12345 around each start, the method the live stamps test already uses, rather than running a second host user. The rootless case used the disposable daemon, which was stopped and removed afterwards with its downloaded tools.

## Needs verification

- Task 3's saving, once built, on the same fixtures and daemons as task 2.
- The live stamps test (`apps/backend/tests/portable-inputs-stamps-docker.test.ts`) on the "Container live qualification" workflow's runner, whose host user is not uid 1000.

## Related

- to-do 1202 efficiency follow-ups, task 15 (retired 2026-11-10).
- Closing check of E25 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), which replaced the 0490 Container start report.
- [6740 input staging follow-ups](6740-input-staging-follow-ups.md).
- [0018 container network and credential isolation](0018-container-network-and-credential-isolation.md).
