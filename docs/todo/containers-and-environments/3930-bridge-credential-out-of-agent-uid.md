# Bridge-control credential is still readable by the agent it controls (H4 remainder)

## Task analysis

Analysed 2026-11-03 against `main` at `7b48c23fb`.

### Tasks

1. **Move the bridge credential out of the agent's uid**: the bridge token is still readable by the agent through the container's token file and `/proc/<bridge pid>/environ`. Status: open.
2. **Narrow-only policy on the other bridge routes that take a policy**: Codex, Pi, Cursor and ACP (and Claude's `/session/create` recovery) replaced a live session's policy from the request body. Status: done.
3. **Authorise widening through the backend**: a user who widens an environment's policy has no way to apply it to a live session on any bridge except a bridge restart. Status: open (depends on 1).
4. **Interaction-answer routes**: any token holder can answer its own pending approvals. Status: open (depends on 1).

### 1. Move the bridge credential out of the agent's uid

**Problem.** Security finding H4 in `docs/reports/2-26-10-27-security.md` is only partly fixed. Every bridge now deletes its token from `process.env` at startup (Claude already did; Codex, Pi, Cursor and ACP since this change), so processes the bridge spawns no longer inherit it. The agent can still read the token another way, because it runs as the same uid as the bridge (`node` in a container, the user on the host).

**Context.**
- Containers: the start scripts write the token with `umask 077` to `/tmp/claude-bridge-token` (`apps/backend/src/core/commands-containers.ts:951`) and `/tmp/codex-bridge-token` (`apps/backend/src/core/commands-registry-servers.ts:422`), and read it back later (`:912`, `:293`, `:392`, `:494`). The file belongs to `node`, the user the agent CLI runs as.
- `/proc/<pid>/environ` is a snapshot of the environment at exec time. Deleting a variable from `process.env` does not change it, and it is readable by any process of the same uid.
- Bun's `Bun.spawn` with no `env` option also passes the startup environment, not the current `process.env` (checked with Bun 1.4.4 on 2026-11-03). `node:child_process` and `Bun.spawn` with an explicit `env` honour the deletion. No production bridge code spawns with `Bun.spawn` and no `env` today (only `bridges/codex-bridge/src/app-server/live-binary.ts`, a live-test helper).

**Investigation.** Not started beyond the facts above. The report's fix list names two options: a root-owned file read by a bridge running under a separate user, or an inherited file descriptor.

**Decisions.**

- **How should the bridge receive its credential?**
  - **Run the bridge as a separate uid and pass the token on an inherited file descriptor (recommended).** The backend starts the bridge with the token on an fd (or a root-owned file readable only by a dedicated `orkbridge` user), the bridge reads it once and closes it, and the agent child is spawned as `node`.
    - Pros: the agent cannot read `/proc/<bridge>/environ` or the file; closes the whole finding.
    - Cons: the bridge and the agent need different uids, so the bridge has to drop privileges for the agent child (or the agent runs under `runuser`); workspace file ownership and the SDKs' assumptions about one user need checking on every provider; host (non-container) environments need a different answer.
  - **Keep one uid, pass the token on an fd only.**
    - Pros: small change; no token file on disk and none in the environment.
    - Cons: a same-uid agent can still read the bridge's memory (`/proc/<pid>/mem` with ptrace permission) or reach the fd through `/proc/<pid>/fd`; it raises the bar but is not a boundary.
  - **Leave it and rely on narrow-only routes.**
    - Pros: no work.
    - Cons: approvals can still be self-answered (task 4), and every route that takes a policy has to stay narrow-only forever.

### 2. Narrow-only policy on the other bridge routes that take a policy

**Problem.** Only Claude's `POST /session/:id/config` was narrow-only. Other routes took a policy from the request body for an existing session.

**Context.** The rule now lives in `packages/protocol/src/execution-policy-narrowing.ts` (`executionPolicyWidenings`), which compares each axis; a route refuses with 403 `policy-widening-refused`.

**Investigation.** Traced on 2026-11-03. What each route did to a live session before this change:

- Claude `POST /session/create` with a resident client key assigned the body's policy, and a body with no usable policy cleared it to the host default.
- Codex `POST /session/:id/config` replaced the policy, and a truthy unusable `policy` cleared it. `POST /session/resume` adds a new bridge session on the named thread under the body's policy, or none. `POST /session/create` with an existing key ignores the body's policy, so it cannot change one. The prompt route read no policy: `prompt-thread-config.ts` only fingerprints thread settings.
- Pi `create` and `resume` assigned the body's policy. Cursor `create` assigned it; Cursor `resume` answered 409 on any difference, narrower included. ACP `resume` replaced it and restarted the child; ACP `create` with an existing key ignored it, narrower included. None of the three prompt routes read a policy.
- Claude keeps no policy across a restart, so a session loaded from disk has none. Codex, Pi, Cursor and ACP persist theirs, so a restored session looked live even though the backend had not yet restated it.
- The backend sends a policy only from `HttpBridgeProvider.createSession` and `resumeSession`. It reuses the stored `existing.policy` for an existing session (`trustedSessionInput`), and `assertSessionIdentity` treats a changed policy as a key collision, so normal flows resend an equal policy.

**Decisions.**

- **Where should the comparison live?**
  - **Move `executionPolicyWidenings` to `packages/protocol` and call it from every bridge (recommended).**
    - Pros: one definition of "narrower" for all providers; one test.
    - Cons: a protocol change, so the whole suite has to run.
  - **Copy it into each bridge.**
    - Pros: no protocol change.
    - Cons: five copies that can drift apart.

### 3. Authorise widening through the backend

**Problem.** When the user widens an environment's policy (for example from Ask to Auto-approve), the backend's resume path sends the wider policy to the bridge, which refuses it with 403 if the conversation is still live there. The wider policy only applies after the bridge restarts, because a session loaded from disk has no live policy and takes whatever the backend sends.

**Context.** `HttpBridgeProvider.resumeSession` (`apps/backend/src/core/http-bridge-provider.ts`) posts `{ policy }` to `/session/:id/config` for Claude and to `/session/resume` for every other bridge, and fails the resume on any non-2xx answer, carrying the bridge's error text. It reaches a live session when a conversation is resumed into a new tab while another still holds it, because a new tab resolves the current environment policy.

**Investigation.** How often a user widens a policy and then resumes a session in the same bridge process has not been measured.

**Decisions.**

- **How should a legitimate widening reach a live session?**
  - **Backend restarts the bridge, then resumes (recommended once task 1 is done).** On `policy-widening-refused`, the backend replaces the bridge process and retries the resume.
    - Pros: the backend, which the agent cannot impersonate after task 1, is the only party that can widen.
    - Cons: interrupts any other session on that bridge; until task 1 lands, the agent can also kill the bridge and race the backend's re-create.
  - **Show the refusal and ask the user to restart the environment.**
    - Pros: no new code path.
    - Cons: the user sees an error for a change they made on purpose.

### 4. Interaction-answer routes

**Problem.** Any holder of the bridge token can answer a pending approval, so an agent that reads the token can approve its own requests.

**Context.** Claude `routes/session.ts` (`/interactions/.../answer`), Codex `index.ts`, ACP `acp-http.ts`, Pi `http.ts`.

**Investigation.** Not started. A narrow-only rule cannot help here: an answer is a decision, not a policy.

**Decisions.**

- **How to stop self-approval?**
  - **Fix the credential (task 1) (recommended).**
    - Pros: covers every route at once.
    - Cons: depends on task 1.
  - **Require a second, backend-only secret on answer routes.**
    - Pros: independent of task 1.
    - Cons: the second secret has the same storage problem as the first.

## Assumptions and decisions

### Where the comparison lives (task 2)

Took the recommended option: `executionPolicyWidenings` moved to `packages/protocol`, with `assertExecutionPolicyNotWidened`, `PolicyWideningRefusedError` and `policyWideningRefusal`, so every bridge gives the same 403 body from one definition.

### What "no live policy" means on a bridge that persists its policy (task 2)

Codex, Pi, Cursor and ACP reload a policy from disk, so comparing against it would make a user's widening unreachable even after a restart, which the ticket and the rule's own comment rely on. Chose an in-memory `policyPending` marker: the restored policy stays in force, the next policy a request sends replaces it, and the marker clears once a request sets one or a prompt starts. The alternative was dropping the restored policy as Claude does, which would run the session on the host default if a prompt arrived first. Pi's and Cursor's fallback for a session no request gave a policy is marked the same way.

The window is a real remainder: an agent that kills its bridge can race the backend to set a restored session's policy, the same as on Claude today and as task 3 already records. Closing it needs task 1.

### Prompt routes (task 2)

None of them reads a policy, so none could change one. The ticket lists Codex, Pi, Cursor and ACP prompts, so those routes now refuse a body naming a wider policy with 403 before anything is journaled, rather than running a turn under less than the caller asked for. A narrower or equal one runs under the session's own policy, which it does not change. Claude's prompt route is not listed and reads no policy, so it was left alone.

### Create on a live session (task 2)

ACP `create` ignored the body's policy on an existing key, so a restored session never took the backend's. It now follows the same rule as `resume`. Codex `create` still ignores it: it cannot change a policy, the ticket does not list it, and applying one needs the engine work `/config` does. A test pins that a wider policy there leaves the session unchanged.

### Applying a narrower policy (task 2)

Pi and Cursor `create` only assigned the policy, which left an attached agent on the old options until its next attach. They now detach first, as Pi's `resume` did, and answer 409 during a turn. Cursor `resume` previously refused any different policy with 409. It now accepts a narrower one, which the ticket requires, and still refuses a composer difference with 409.

### A legitimate widening that now gets 403 (task 2)

Handled as Claude's `/config` refusal is: the resume fails with the bridge's message and the backend does not retry. Codex's resume now uses `assertOkWithErrorDetail` so its message says why. Task 3 owns the better answer.

## Related

- `docs/reports/2-26-10-27-security.md`, H4 (status: partly fixed) and M13.
- [`4210-read-only-boundary-from-a-token-holder.md`](4210-read-only-boundary-from-a-token-holder.md): the read-only boundary, which is not part of the policy.
