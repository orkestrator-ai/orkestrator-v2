# Bridge-control credential is still readable by the agent it controls (H4 remainder)

## Task analysis

Analysed 2026-11-03 against `main` at `7b48c23fb`.

### Tasks

1. **Move the bridge credential out of the agent's uid**: the bridge token is still readable by the agent through the container's token file and `/proc/<bridge pid>/environ`. Status: open.
2. **Narrow-only policy on the other bridge routes that take a policy**: Codex, Pi, Cursor and ACP (and Claude's `/session/create` recovery) still replace a live session's policy from the request body. Status: open.
3. **Authorise widening through the backend**: a user who widens an environment's policy has no way to apply it to a live Claude session except a bridge restart. Status: open (depends on 1).
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

**Problem.** Only Claude's `POST /session/:id/config` is narrow-only. Other routes still take a policy from the request body for an existing session.

**Context.** Claude's rule lives in `bridges/claude-bridge/src/services/execution-policy-narrowing.ts` (`executionPolicyWidenings`), which compares each axis and refuses with 403 `policy-widening-refused`. Routes that still replace a policy: Claude `POST /session/create` when the client key names a resident session (`createOrRecoverSession` in `session-manager-session.ts`); Codex config, prompt and resume paths (`prompt-thread-config.ts`, `app-server-runtime-sessions.ts`); Pi, Cursor and ACP create/resume and prompt bodies (`bridges/pi-bridge/src/http.ts` and the equivalents).

**Investigation.** The routes were found by searching for `body.policy`; each one's exact effect on a live session has not been traced.

**Decisions.**

- **Where should the comparison live?**
  - **Move `executionPolicyWidenings` to `packages/protocol` and call it from every bridge (recommended).**
    - Pros: one definition of "narrower" for all providers; one test.
    - Cons: a protocol change, so the whole suite has to run.
  - **Copy it into each bridge.**
    - Pros: no protocol change.
    - Cons: five copies that can drift apart.

### 3. Authorise widening through the backend

**Problem.** When the user widens an environment's policy (for example from Ask to Auto-approve), the backend's resume path posts the wider policy to Claude's `/config`, which now refuses it with 403. The wider policy only applies after the bridge restarts, because a session loaded from disk starts with no policy and takes whatever the backend sends.

**Context.** `HttpBridgeProvider.resumeSession` (`apps/backend/src/core/http-bridge-provider.ts`) posts `{ policy }` to `/session/:id/config` for Claude and fails the resume on any non-2xx answer.

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

## Related

- `docs/reports/2-26-10-27-security.md`, H4 (status: partly fixed) and M13.
