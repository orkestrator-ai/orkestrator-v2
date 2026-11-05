# A process running as the agent's uid can still catch a bridge token or OpenCode's password in flight

Carried from security report S2, part `0040` task 1, when that report was closed (2026-11-04). See the Related section for what S2 did.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

### Tasks

1. **Stop an imposter on the bridge's port catching the token**: an agent can kill its own bridge and listen on the port, and the backend then presents it the real token. Status: open.
2. **Stop code planted for the next bridge start**: the start script runs as `node` and reads files `node` can write, so an agent can run code inside the next bridge. Status: open.
3. **Decide what a host environment promises**: on the host the agent is the user, so no file permission or uid separates it from the backend. Status: open.
4. **Decide what OpenCode's own store and configuration promise**: `node` owns the files OpenCode reads its rules from, so an agent can widen what it is asked about without answering anything. Status: open.

### 1. Stop an imposter on the bridge's port catching the token

**Problem.** A bridge holds only a hash of its token, in a process the agent's uid cannot read, so an agent cannot read the token out of it. But the backend still sends the token on every request. An agent that can run a background process can kill the bridge (same uid), bind the same port, and read the token from the backend's next request (the activity sweep sends one within seconds). It can then start a real bridge from the verifier and answer approvals on sessions that bridge restores or creates.

**Context.** The start paths accept a running listener after an unauthenticated health check (`startContainerClaudeServer`, the `start_*_server` handlers in `commands-registry-servers.ts`), and `peekContainerAgentBridge` sends the token to whatever answers the port. A kill also ends the agent's own session and every approval parked on that bridge, so this needs a detached process, not one tool call. The attack needs an agent that can already run a persistent process, which on an `ask` environment means a command the user approved. The same holds for OpenCode (`startContainerOpenCodeServer`, whose password goes to whatever answers port 4096), with one difference: it takes the plain password, so a process already running as `node` when a server starts can also read it from `/tmp/.orkestrator-start-*` or from the server's environment in the seconds before its plugin loads.

**Investigation.** Not exercised as an attack. Reasoned from the routes: `bridges/*` compare one presented token; nothing proves the listener is the bridge the backend started. `apps/backend/tests/bridge-credential-docker.test.ts` proves the token cannot be read while the real bridge runs; it does not cover this.

**Decisions.**

- **How should the backend stop giving the token to an imposter?**
  - **Sign what changes an agent's authority (recommended).** The backend keeps an Ed25519 private key per bridge in the same root-only file and gives the bridge the public key. Approval answers, `readOnly: false` and a wider policy carry a signature over session, request id and a digest of the request as the backend saw it.
    - Pros: a caught bearer token no longer answers an approval; replay is limited to the request the user actually answered; works on all five bridges, in process or not.
    - Cons: every answer route and the backend's answer path change; a captured bearer token still reads transcripts and sends prompts; needs a compatibility path for bridges without a key.
  - **Run the bridge under its own uid.** What to-do 3930 task 1 recommended.
    - Pros: the agent cannot kill the bridge, so nothing else is needed.
    - Cons: not possible for Pi and Cursor, whose SDKs run tools in the bridge process; for Claude, Codex and Grok the bridge reads `~/.claude`, rollouts and sessions the CLI writes mode 600 under a mode 700 home. See 3930's decision record.
  - **Check the listener is the bridge started before sending the token.** A root exec comparing the port's owner against a recorded pid and start time.
    - Pros: small, and root is already used to read the token.
    - Cons: one more exec on a two-second sweep, and a race between the check and the request.

### 2. Stop code planted for the next bridge start

**Problem.** The token is safe from a running bridge, but a bridge the agent has prepared is another matter. Code running inside the bridge sees each token presented to it.

**Context.** S2 closed two paths: `bun --config=/dev/null` stops a checkout's `bunfig.toml` preloading into the bridge, and `/opt/*-bridge` is root-owned on `bridge-credential=1` images. These remain: `docker exec ... bash -lc` reads `~/.bash_profile` and `~/.profile`; the start scripts source `/tmp/orkestrator-ai` through `orkestrator_source_runtime_env`; and `BUN_OPTIONS`, `LD_PRELOAD` and similar set by either of those reach the bridge (checked for `BUN_OPTIONS` on 2026-11-04 in a real container: `--config=/dev/null` does not stop it).

OpenCode has more of these, all read when an instance starts: plugins in `~/.config/opencode/plugins` (the credential plugin's own file among them), `/workspace/.opencode/plugins`, and the `plugin` key of `opencode.json`. A plugin runs inside the server and is handed a client that needs no password. `opencode` itself is at `/home/node/.opencode/bin`, which `node` owns.

**Investigation.** Each file above is `node`-writable by design (`docker/verify-root-boundary.sh`). Bun does not read `~/.bunfig.toml` when running a script (checked the same day). OpenCode's plugin loading was read from behaviour on 2026-11-05: `apps/backend/tests/bridge-credential-docker.test.ts` does not plant one.

**Decisions.**

- **How should a bridge start without reading what the agent can write?**
  - **Launch through a root-owned script with a fixed environment (recommended).** `docker exec --user node` runs `/usr/local/bin/orkestrator-bridge-launch` with no login shell and a fixed `PATH`, which applies only the backend's values, and the bridge passes the runtime environment to the agents it spawns rather than holding it itself.
    - Pros: closes the whole class for bridges; the agent's tools keep their environment.
    - Cons: every bridge needs to source the runtime environment for its children; needs a new image capability; OpenCode would also need `OPENCODE_DISABLE_PROJECT_CONFIG` and a config directory `node` cannot write, because it loads plugins itself.
  - **Scrub known variables on the launch line.**
    - Pros: one line.
    - Cons: a list of dangerous variables is never complete, and a planted `bun` function in `~/.bash_profile` still runs.

### 3. Decide what a host environment promises

**Problem.** A local (non-container) bridge takes a verifier and is non-dumpable on Linux, but the agent runs as the user, who owns the backend, its data directory and its memory.

**Context.** `commands-servers.ts` keeps a local bridge's token in the backend process. On macOS `markProcessNonDumpable` does nothing (no `prctl`). A sandboxed host agent is held by its OS sandbox rather than by any of this. A local OpenCode server takes the credential plugin (`opencode-host-credential.ts`) unless the user set `OPENCODE_CONFIG_DIR`, which removes the password from its tools' environment; it does not make the host a boundary.

**Investigation.** Host behaviour read from code. Sandbox interactions were not exercised.

**Decisions.**

- **What should a hardened host environment claim?**
  - **State that approvals on an unsandboxed host environment are a prompt, not a boundary (recommended).**
    - Pros: true; no code path pretends otherwise.
    - Cons: users may have assumed more.
  - **Run host bridges and agents under separate OS users.**
    - Pros: a real boundary.
    - Cons: needs an installer and privileges the app does not have, on every platform.

### 4. Decide what OpenCode's own store and configuration promise

**Problem.** An approval can no longer be answered without the password, but an agent does not need one to stop being asked. Rules live in files `node` owns.

**Context.** `~/.local/share/opencode/opencode.db` has a `permission` column on `session` and a `permission` table of project approvals, and `opencode.json` (user or `/workspace`) has a `permission` key. Claude's `settings.json` under `~/.claude` is the same kind of file for that provider. Getting there needs a tool that can write them, which on an `ask` environment is a tool the user approved.

**Investigation.** The schema was read from a real 1.19.5 database on 2026-11-05. Whether a row changed while a session runs takes effect at once, or only at the next instance, was not exercised. The backend does not set `OPENCODE_DISABLE_PROJECT_CONFIG` for container servers.

**Decisions.**

- **What should be done?**
  - **State it as part of what `ask` means on a shared uid, next to task 3's statement (recommended).**
    - Pros: true for every CLI provider; no code pretends otherwise.
    - Cons: the limit stays.
  - **Run OpenCode's state and configuration somewhere `node` cannot write.**
    - Pros: a real boundary for this one provider.
    - Cons: the server runs as `node` and writes its own database, so it needs its own uid, and then its tools do too (to-do 3930's decision record).

## Related

- [`3930-bridge-credential-out-of-agent-uid.md`](3930-bridge-credential-out-of-agent-uid.md) (the design this limits)
- [`4981-opencode-password-readable-by-agent.md`](4981-opencode-password-readable-by-agent.md) (what OpenCode's server does now)
- [`4210-read-only-boundary-from-a-token-holder.md`](4210-read-only-boundary-from-a-token-holder.md)
- `docs/reports/2-26-10-27-security.md`, H4.
