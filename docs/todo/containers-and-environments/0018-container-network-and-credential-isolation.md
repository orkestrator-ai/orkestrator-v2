# Container network and credential isolation

Checked against `main` at `2459b05c` (2026-10-15); Claude credentials
against `688f9f69` (2026-10-21); default allowlists and the external egress
prototype against `b83ae534` (2026-10-22); the production egress gateway and
the credential-delivery items against branch
`todo-0018-container-isolation-e228f2a04b8e` (2026-10-25); tasks 3 and 9
against `main` at `931e5541` (2026-10-31).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Gateway on rootful Linux Engine**: qualify the egress gateway on Linux Engine amd64 and arm64. Status: partly done (CI evidence recorded 2026-10-31 under Qualification; ticking it waits for the decision below).
2. **Gateway on rootless**: run the gateway suites against a current image on a rootless daemon. Status: partly done.
3. **IPv6, daemon restart and DNS rotation**: the three gateway conditions no run has covered on any engine. Status: done 2026-10-31 on a disposable rootful Linux Engine 29.9.2; DNS rotation found and fixed a revocation gap. A rootless daemon restart stays with task 2.
4. **Retire the `ORKESTRATOR_EGRESS=in-container` rollout cap**: remove the switch once tasks 1 to 3 pass. Status: blocked (on tasks 1 to 3).
5. **Claude host refresh and mid-session pickup**: first live run of `refreshHostClaudeLogin`, plus re-checking the trigger against the current Claude Code pin. Status: open.
6. **Container-made Claude MCP login survival**: a live `claude /mcp` sign-in inside a container survives a keeper push and a restart. Status: open.
7. **Grok renewal pickup and past-expiry sign-out**: live Grok checks for items 5 and 7 and the past-expiry property. Status: blocked (on a fresh host Grok login).
8. **OpenCode and Pi past expiry and sign-out**: live OAuth checks for OpenCode and Pi, including item 7's sign-out removal. Status: blocked (on a fresh host OpenCode or Pi OAuth login).
9. **Stale statements in this file**: a renamed function, a rootless claim that is now out of date, and the CI run that is not recorded. Status: done 2026-10-31.

### 1. Gateway on rootful Linux Engine

**Problem.** The egress gateway is on by default for every restricted runtime on a current image. This file says it has been proved only on Docker Desktop, so Linux users run an unqualified default.

**Context.** Item 1's last checkbox and the "Egress gateway on Linux Engine and rootless" qualification entry. The file expects `container-live-qualification.yml` to collect the evidence on `ubuntu-24.04` and `ubuntu-24.04-arm`.

**Investigation.** The workflow has run. Run 40409285999 is the latest pull-request run, at head `e53ea683` on 2026-10-26. Run 40338400817, at head `e8306626` on the 0109 branch (#1307), passed every step on both runners. Its image manifest declared `egress-gateway=1,network-policy=3`, so the suites ran behind the gateway:
- network (C22 sibling and host isolation): 4/4.
- firewall (C23 edits, refresh, revocation; `CapEff` 0; `orkroot` tampering refused; gateway restart; policy 3 tuples): 2/2. On a gateway image this is `apps/backend/tests/container-live-firewall.test.ts:178`, with the tamper checks at `:248`-`:294`.
- readiness, including "a gateway that cannot apply its firewall refuses the start": 9/9.
- replacement, including "the candidate gets its own gateway on the fixed host port": 11/11.

In run 40409285999 the x64 network suite passed again. The only failure there was `C14 legacy migration with staged provider inputs`, which belongs to the replacement suite and not to the gateway. The weekly scheduled run on `main` (40304582303, 2026-10-26) failed in the lifecycle step. Neither this file nor `docs/development/container-qualification.md` records any of these runs: the doc still lists Linux Engine as "Not covered" (`container-qualification.md:185`). The code paths are unchanged: `egressEnforcement` (`apps/backend/src/core/egress-gateway.ts:77`), gateway creation (`apps/backend/src/core/commands-containers.ts:594`) and the runtime joining it (`commands-containers.ts:615`-`:622`).

**Decisions.**

- **Does the CI evidence count as Linux Engine qualification?**
  - **Yes, record runs 40338400817 and 40409285999 as the rootful amd64 and arm64 pass (recommended).** Cite them in `container-qualification.md` and tick this half.
    - Pros: the same suites the Desktop qualification used, on both architectures, against an image built from the branch, with exit statuses on record.
    - Cons: hosted runners are one kernel and one Engine build, and IPv6, daemon restart and DNS rotation are still not covered (task 3).
  - **No, require a manual run on a self-managed Linux host.**
    - Pros: a configuration closer to a user's machine.
    - Cons: duplicates evidence that already exists, and delays retiring the cap without finding anything new.
- **What to do about the failing weekly and C14 runs?**
  - **Treat them as separate from this task and check that some other todo (0019 or 0058) tracks them (recommended).**
    - Pros: keeps this file's scope; neither failure touches gateway behaviour.
    - Cons: needs a cross-check that someone owns them.
  - **Hold this task until the whole workflow is green.**
    - Pros: one clean run to cite.
    - Cons: ties network qualification to unrelated migration fixtures.

### 2. Gateway on rootless

**Problem.** Rootless Docker is a supported topology, and the gateway is on there by default too. A rootless kernel without `hash:net,port` would fail closed at boot.

**Context.** Same qualification entry, plus [0109](0109-rootless-linux-runtime-gaps.md), which closed the rootless runtime gaps in #1307 (`1aabf049`).

**Investigation.** Two rootless runs since this file was checked cover parts of it:
- The 2026-10-25 run on a real rootless Engine 29.9.1 host passed the live firewall suite 2/2, including the policy 3 tuples, with `ip_set`, `xt_set` and `nf_tables` loaded (`container-qualification.md:215`). That answers this file's "a rootless kernel is still unconfirmed" for that kernel. The image was a review build, and whether it carried `egress-gateway=1` is not recorded.
- The 2026-10-26 rootless review qualification ran with host loopback enabled and an image carrying `staged-inputs=3`. C22 "passed behind the real egress gateway" (`container-qualification.md:312`-`:314`), but that write-up does not list the firewall suite.

Still unproved on rootless with a current image: the firewall suite's gateway-specific checks (tampering, gateway restart) and the default host-loopback-disabled daemon behind a gateway. 0109 decision 4 also notes that existing gateway runtimes need a rebuild after host loopback is enabled.

**Decisions.**

- **What run closes rootless?**
  - **The live firewall, network and readiness suites, once on a host rootless daemon with a current image and default settings, and the firewall suite again with host loopback enabled (recommended).**
    - Pros: covers both daemon settings users actually have, and reuses the 0109 disposable-daemon recipe.
    - Cons: needs a full image build on the rootless host, which the 0109 runs avoided for disk-space reasons.
  - **Accept the 2026-10-25 and 2026-10-26 evidence as enough.**
    - Pros: no new run.
    - Cons: the gateway's tamper and restart checks were never shown on rootless, and the 2026-10-25 image may not have had a gateway.
- **Add a rootless job to `container-live-qualification.yml`?**
  - **No, keep rootless as a manual run for now (recommended).**
    - Pros: hosted runners do not offer a rootless daemon out of the box, and 0109 already has a working manual recipe.
    - Cons: rootless can regress unnoticed between manual runs.
  - **Yes, set up a rootless daemon in a CI job.**
    - Pros: repeated evidence on every change to the suites.
    - Cons: setup cost and flakiness, and `nosuid`/`nodev` and port-collision behaviour depend on the host.

### 3. IPv6, daemon restart and DNS rotation

**Problem.** Three gateway conditions have not been run on any engine: a daemon with IPv6 enabled, a Docker daemon restart with stopped runtimes and gateways, and real DNS rotation. Each could leave a runtime unrestricted, or unable to start, in a way the current suites would not catch.

**Context.** The file lists all three as owed for the gateway. 0019 owes DNS rotation and IPv6 for its packet matrix too. The constraints require IPv6 to stay dropped unless it is enforced.

**Investigation.** IPv6 is closed twice. The gateway is created with `net.ipv6.conf.all.disable_ipv6=1` (`egress-gateway.ts:157`) and in-container runtimes get the same sysctl (`commands-containers.ts:627`). On top of that, `docker/init-firewall.sh:84`-`:97` sets `ip6tables` DROP, or fails if IPv6 is configured with no `ip6tables`. C22 asserts that IPv6 is `blocked` or `disabled` (`apps/backend/tests/container-live-network.test.ts:210`). No live test restarts the Docker daemon: nothing under `apps/backend/tests` does, and runtimes have no restart policy by design. DNS re-resolution is covered only by the C23 refresh test and the forged-DNS tuple test (`container-live-firewall.test.ts:579`-`:592`), not by a domain whose real addresses rotate.

**Decisions.**

- **How to cover the daemon restart?**
  - **A manual run on a disposable daemon (rootful or the 0109 rootless one) with a scripted checklist: stop, restart the daemon, start through the backend, verify order and policy (recommended).**
    - Pros: no CI runner can safely restart its own daemon mid-job, and a disposable daemon cannot touch the production one.
    - Cons: one-off evidence.
  - **A live test that restarts the daemon.**
    - Pros: repeatable.
    - Cons: on any shared host it kills every other container, including production Orkestrator's.
- **How to test IPv6?**
  - **Create the environment network on a daemon with `default-network-opts` enabling IPv6 and confirm C22 still reports `blocked`/`disabled` with no global IPv6 address reachable (recommended).**
    - Pros: tests the configuration that would actually hand containers IPv6.
    - Cons: needs a host or runner with IPv6 configured.
  - **Rely on the sysctl and `ip6tables` DROP by inspection.**
    - Pros: no run.
    - Cons: the constraint says "implemented and tested", and a daemon option overriding the sysctl would go unseen.
- **DNS rotation pass criterion?**
  - **Run a container for longer than one record TTL against a CDN-backed allowed domain and confirm that new addresses are added and expired ones age out after six hours, without an allow-all window (recommended).**
    - Pros: the property the firewall design claims.
    - Cons: takes hours, so it suits a manual or scheduled run.
  - **Accept the forged-DNS and refresh tests.**
    - Pros: already pass in CI.
    - Cons: they never exercise real TTL-driven turnover.

**Result (2026-10-31).** All three conditions ran against a disposable Docker
daemon on beelink (Arch Linux, kernel 7.1.8, x86_64): `docker:29-dind`
(Engine 29.9.2, rootful) in a privileged container with its own data volume
and a supervisor that restarts `dockerd` when it exits, so the host daemon was
never restarted or reconfigured. Its `daemon.json` enabled IPv6 on every new
bridge network (`default-network-opts`), with address pools `172.30.0.0/16`
and the global-scope `2001:db8:100::/56`. Image: `orkestrator-v2:latest`
(`2.34.4-beta`, revision `f2d21713`, whose firewall and gateway scripts match
`main`; capabilities include `egress-gateway=1`, `network-policy=3`), plus
`orkestrator-v2:q0018-revoke`, the same image with this change's
`firewall-domains.sh`. The new opt-in suite
`apps/backend/tests/container-live-egress-conditions.test.ts` creates and
starts runtimes through the backend (`createDockerContainer`,
`prepareEgressGatewayForStart`). Details are in
[container qualification](../../development/container-qualification.md#egress-gateway-conditions-on-linux-engine-2026-10-31).
- **IPv6: passed, nothing to fix.** The environment network, created by the
  backend's own `network create`, got `2001:db8:100::/64`. A control container
  without the sysctl reached a peer's IPv6 echo port. The gateway and the
  runtime had no IPv6 address at all (`/proc/net/if_inet6` empty) and
  `disable_ipv6=1` on every interface, including one Docker attached after
  creation. The runtime could not reach the peer over IPv6 as `node` or root.
  The report said `ipv6: blocked`, with `ip6tables -P OUTPUT DROP` in the
  gateway. The same held on a daemon without the IPv6 default when the test
  attached an IPv6 network to the gateway itself
  (`ORKESTRATOR_LIVE_IPV6_NETWORK=1`).
- **Daemon restart: passed, nothing to fix.** With `live-restore` off (two
  real `dockerd` restarts): a runtime stopped through the backend, and one
  running when the daemon stopped, both came back with neither container
  started by Docker. A bare `docker start` of the runtime was refused while
  its gateway was stopped. The backend's start path brought both up in order
  with the policy applied: `CapEff` 0, `-P OUTPUT DROP`, IPv6 off, the allowed
  registry reachable and `example.com` rejected. With `live-restore` on, both
  containers kept running in the same namespace (gateway `StartedAt`
  unchanged). The rules, Docker's embedded DNS and a manual refresh all
  worked afterwards, and the start path returned `ready`.
- **DNS rotation: one gap found and fixed.** A resolver inside the gateway
  answered the allowed name with local peers' addresses and rotated them.
  Added addresses got the full 21,600 s kernel timeout, and a rotated-away
  address kept the rest of its own timeout. An open connection to it survived
  the rotation. A watcher probing every 50 ms through five swaps never reached
  the unlisted peer and was never refused by the carried one. The refresh
  delay followed the TTL within its bounds (30 s became 300, 4000 s became
  1800). The kernel dropped an expired address on time with no refresh
  running, and new connections were refused. **But a connection opened before
  that expiry kept working, through the next refresh and indefinitely.**
  `ork_rebuild_allowlist` revoked only what the live set held before the swap,
  and the kernel had already removed the expired entry. That broke the
  documented guarantee that an address leaving the set has its tracked
  connections deleted. **Fix:** every application now records the set's
  members (`/var/lib/orkestrator/allowed-entries`), and a rebuild revokes what
  that record or the live set held and the new set lacks. A connection to an
  expired address is now cut at the next refresh, at most 30 minutes after
  the expiry. Regression tests: `tests/unit/firewall-refresh.test.ts` ("an
  address the kernel expired between refreshes still has its connections
  revoked", which fails before the fix), and the live DNS test, which failed at
  that assertion on the release image and passes on the patched one.

### 4. Retire the `ORKESTRATOR_EGRESS=in-container` rollout cap

**Problem.** The cap keeps a second topology alive, one where a root terminal can change the firewall. Every gateway change has to stay correct for both.

**Context.** "Assumptions and decisions": "to be removed once Linux Engine and rootless pass". `docs/architecture/container-lifecycle.md:529` lists it under rollout switches.

**Investigation.** The override is read in `egressEnforcement` (`egress-gateway.ts:85`), and it is the only consumer besides tests and the live firewall suite's in-container variant. Removing it does not affect older images or policy 1 runtimes. Those still take the in-container path through `networkPolicy < 2 || imageGatewayVersion < 1` (`egress-gateway.ts:84`).

**Decisions.**

- **When to remove it?**
  - **After tasks 1 and 2 are recorded, without waiting for task 3 (recommended).** Task 3 does not depend on the cap.
    - Pros: matches the stated condition and drops the root-terminal-can-change-firewall path for current images sooner.
    - Cons: if task 3 finds an IPv6 or daemon-restart problem, users lose the quick workaround and need a release instead.
  - **After tasks 1 to 3.**
    - Pros: the workaround stays until every known condition is proved.
    - Cons: task 3 has no date, so the dual topology could stay indefinitely.
- **Keep the in-container firewall live-suite variant afterwards?**
  - **Yes, keep it for older images (recommended).**
    - Pros: legacy runtimes still use that path until they are rebuilt.
    - Cons: the test needs another way to select the topology, such as a policy 2 image.
  - **No, drop it with the cap.**
    - Pros: less test code.
    - Cons: legacy runtimes lose their live coverage.

### 5. Claude host refresh and mid-session pickup

**Problem.** The keeper refreshes the host Claude login through `refreshHostClaudeLogin`, on by default. Nobody has run it against a real login, so a wrong trigger would sign out every container's Claude after about eight hours, or bill a model request.

**Context.** The "Claude host refresh and mid-session pickup, live (high)" entry. The trigger is a `-p` run with an unknown model (`CLAUDE_HOST_REFRESH_MODEL`). The file says to re-check it after each Claude Code upgrade.

**Investigation.** `refreshHostClaudeLogin` (`apps/backend/src/core/claude-host-login-refresh.ts:35`) is unchanged since `c17f1c8d` (2026-10-22). The keeper polls every five minutes and refreshes inside a five-minute lead (`apps/backend/src/core/container-claude-login-keeper.ts:43`-`:48`, `TOKEN_REPLACEMENT_LEAD_MS` at `apps/backend/src/core/agent-accounts-active.ts:178`), so this file's "last four minutes" is a looser test window than the code's. The pins have moved since the check: `CLAUDE_CLI_VERSION=2.1.314` (`docker/Dockerfile:193`, as of 2026-10-31), and the Agent SDK is 0.3.314. `docs/development/upgrade-agents.md:636` says the trigger "is still as checked against 2.1.296", so the required re-check after the upgrade was not done.

**Decisions.**

- **Where to run it?**
  - **A disposable Claude account on a real (non-agent-test) instance, with a container bridge running, timed into the last five minutes (recommended).**
    - Pros: spends no one's real refresh token, and an agent-test profile refuses this path (`claude-host-login-refresh.ts:40`).
    - Cons: needs a spare Claude subscription.
  - **The user's own host login.**
    - Pros: no extra account.
    - Cons: a failure signs the user out of every Claude client on the host.
- **Re-check the trigger against the current pin (2.1.314) first?**
  - **Yes, repeat the fake-login container probe on the current pin before the live run (recommended).**
    - Pros: cheap, no credentials, and the upgrade guide already demands it.
    - Cons: a fake token still cannot prove a proactive refresh of a real unexpired token.
  - **Go straight to the live run.**
    - Pros: one run.
    - Cons: a failed live run would not say whether the trigger or the CLI changed.

### 6. Container-made Claude MCP login survival

**Problem.** Item 3 keeps an MCP OAuth login made inside a container through keeper pushes. That has been tested only against real files with synthetic tokens, never with a real `claude /mcp` sign-in.

**Context.** The "Container-made MCP login and renewal pickup, live (medium)" entry. Digests are held in memory only, so a backend restart forgets which refresh tokens came from the host.

**Investigation.** `buildMergeContainerClaudeCredentialCommand` (`apps/backend/src/core/agent-accounts-containers.ts:780`) and its tests in `apps/backend/tests/agent-accounts-containers.test.ts` are present. Nothing live has run.

**Decisions.**

- **Include a backend restart in the run?**
  - **Yes: sign in, wait for a keeper push, restart the container, restart the backend, push again, then check with `jq 'keys'` (recommended).**
    - Pros: covers the in-memory digest limitation the decision record admits.
    - Cons: a longer run on a real MCP server account.
  - **Only a keeper push and a container restart, as written.**
    - Pros: the stated procedure.
    - Cons: misses the case most likely to fail.
- **Which MCP server?**
  - **Any OAuth MCP server with a free tier and a disposable account (recommended).**
    - Pros: no production credentials at risk.
    - Cons: the token lifetime may be too long to observe a renewal.
  - **A server the user already uses.**
    - Pros: realistic.
    - Cons: risks the user's own login.

### 7. Grok renewal pickup and past-expiry sign-out

**Problem.** Two Grok properties are unproved live. First, whether a pushed host renewal reaches a running session (item 5). Second, that a container signs out on its own past expiry and a bridge restart after a host `grok` run signs it back in. The Codex half passed on 2026-10-21.

**Context.** The "Grok past expiry with a live login (medium)" entry and the Grok half of the MCP/renewal entry. Both have waited since 2026-10-21 because the host Grok login has been expired. [0061](0061-container-qualification-follow-ups.md) also owes the opt-in `e2e/agent-testing/grok-container-login.spec.ts` run.

**Investigation.** The push this file calls `syncContainerGrokLogin` no longer exists by that name. Grok goes through the shared `syncContainerLogin` (`agent-accounts-containers.ts:636`), with its own entry in the provider table (`:516`) and the sign-out drop at `:669`-`:682`. `ContainerLoginFileWatcher` polls every 60 s (`apps/backend/src/core/container-login-file-watcher.ts:43`). The Grok pin is now 1.0.70 (`GROK_BUILD_VERSION`, `docker/Dockerfile:196`, as of 2026-10-31); the 2026-10-21 container ran 1.0.52.

**Decisions.**

- **Fold this into 0061's `grok-container-login.spec.ts` run?**
  - **Yes, one session with a fresh host Grok login covers both files, recorded in each (recommended).**
    - Pros: the precondition is the same and rare, and one login refresh serves both.
    - Cons: the spec may not cover mid-session pickup, which needs a manual step.
  - **Run them separately.**
    - Pros: each file's evidence stands alone.
    - Cons: needs two fresh logins, or two windows inside one.
- **What counts as a pass for mid-session pickup?**
  - **A turn after the push succeeds without a bridge restart. If it fails, record "requires bridge restart" as the documented behaviour (recommended).**
    - Pros: either result closes the unknown, and the backend already restarts bridges on the next start.
    - Cons: a negative result may call for new work in a new todo.
  - **Require pickup without a restart.**
    - Pros: a stronger guarantee.
    - Cons: Grok's binary behaviour is outside Orkestrator's control.

### 8. OpenCode and Pi past expiry and sign-out

**Problem.** The access-only OpenCode and Pi copies, the merge push and item 7's sign-out removal have not been run with a real OAuth login. The host has had API keys or an expired Pi login only.

**Context.** The "OpenCode and Pi past expiry with live OAuth logins (medium)" entry. The rotation analysis was made against OpenCode 1.19.0 and Pi 1.2.0 sources.

**Investigation.** The pins have moved to `OPENCODE_CLI_VERSION=1.19.5` and `PI_CLI_VERSION=1.4.0` (as of 2026-10-31) (`docker/Dockerfile:195`, `:197`). The restriction fails safe: only providers named in `NON_ROTATING_OAUTH_PROVIDERS` (`packages/protocol/src/login-snapshots.ts:226`) keep their refresh token. Any other OAuth provider, including one added upstream since, is staged access-only (`login-snapshots.ts:311`-`:324`). A new provider can therefore cost a sign-out, but cannot leak a rotating token. The merge command is `buildMergeContainerProviderAuthCommand` (`agent-accounts-containers.ts:567`).

**Decisions.**

- **Re-check the rotation analysis against the new pins first?**
  - **Yes, diff the OAuth plugin and `pi-ai` provider lists between the analysed and pinned versions before the live run (recommended).**
    - Pros: a static check, and it catches a provider that now reuses its refresh token and could be kept whole.
    - Cons: the fail-safe default means it changes only usability, not safety.
  - **Skip it.**
    - Pros: less work.
    - Cons: the file's "checked against" claims go stale.
- **Use an edited `expires` or wait for real expiry?**
  - **Edit `expires` in the container's copy for the sign-out check, and wait for a real host refresh for the hash check (recommended).**
    - Pros: minutes instead of hours, and the host-hash property still needs a real host refresh.
    - Cons: an edited `expires` does not prove the provider rejects the real expired token.
  - **Wait for real expiry.**
    - Pros: fully real.
    - Cons: six to ten hours per provider.

### 9. Stale statements in this file

**Problem.** A few statements no longer match the code or the evidence, which misleads anyone picking up the remaining runs.

**Context.** Found while checking tasks 1 to 8.

**Investigation.**
- `syncContainerGrokLogin` (line 106 of the original text) is now `syncContainerLogin` (`agent-accounts-containers.ts:636`).
- "A rootless kernel is still unconfirmed" is out of date: tuples passed on rootless on 2026-10-25 (`container-qualification.md:215`).
- The Linux Engine CI passes from task 1 are not recorded.
- The Claude test window says "last four minutes" while the code uses five.
- The Claude, OpenCode and Pi version claims predate the current pins.

**Decisions.**

- **Fix them now or with the qualification runs?**
  - **Correct them in the same change that records task 1's evidence (recommended).**
    - Pros: one edit, made while the evidence is being written up anyway.
    - Cons: they stay wrong until someone takes task 1.
  - **Fix them in a standalone documentation change now.**
    - Pros: immediate accuracy.
    - Cons: a second edit to the same lines soon after.

**Result (2026-10-31).** Corrected together with task 3's write-up, which
also records the CI evidence for task 1:
- "Current state" now names `syncContainerLogin` for the Grok push.
- The tuple entry no longer says a rootless kernel is unconfirmed, and points
  at the 2026-10-25 rootless pass.
- Qualification records the Linux Engine CI runs, re-checked with `gh run
  view`. 40338400817 (`e8306626`, 2026-10-26) and 40999226305 (`79c35c0b`,
  2026-10-30, the latest, Engine 28.0.4, image `egress-gateway=1`) passed
  every step on `ubuntu-24.04` and `ubuntu-24.04-arm`: replacement 12/12,
  network 4/4, firewall 2/2, readiness 9/9 on each. Run 40409285999 failed
  only in C14 legacy migration (replacement suite), and the weekly
  40304582303 in the lifecycle step. PR runs 40746551838 (2026-10-28) and
  40799843615 (2026-10-29) also passed. `container-qualification.md`'s
  "Not covered: Linux Engine" line is in the 2026-10-25 Desktop entry and is
  left as history; the new 2026-10-31 entry records the CI runs.
- The Claude test window now says five minutes.
- The pins quoted in tasks 5, 7 and 8 are updated to `docker/Dockerfile`
  today: Claude Code 2.1.314 with Agent SDK 0.3.314, Grok 1.0.70, OpenCode
  1.19.5, Pi 1.4.0. The OpenCode and Pi rotation analysis is marked as made
  against 1.19.0 and 1.2.0 and not re-checked since (task 8 owns that).

Restricted mode limits where a container can connect with an IPv4 ipset
firewall. Since 2026-10-25 a restricted runtime from a current image is
enforced from outside: an egress gateway owns its network namespace and the
runtime holds no `NET_ADMIN`. Containers receive access-only copies of the
host's rotating OAuth logins, and renewals now reach running containers. What
remains is live qualification: the gateway on rootless (Linux Engine CI
passes and the IPv6, daemon-restart and DNS-rotation conditions are recorded),
and renewal delivery with real, fresh provider logins.

## Current state

- Firewall: `docker/init-firewall.sh` (boot, policy 3), `docker/firewall-domains.sh`
  (shared library: per-address expiry, TTL refresh, atomic `ipset swap`,
  conntrack revocation, which since 2026-10-31 also covers an address the
  kernel expired between refreshes), `docker/update-firewall.sh` (`--set-domains`,
  `--add`, `--remove`, `--host-ports`, `--refresh-loop`) and
  `docker/network-policy-entrypoint.sh` (records the policy once, root-owned).
- Allowed traffic sits in one ipset, `allowed-domains`. Under policy 3 it
  holds address, protocol and port tuples (`hash:net,port`): a bare domain is
  TCP 443, `host:port` or `host:port/udp` opens exactly that port, and
  GitHub's ranges are TCP 443 and 22. Policies 1 and 2 hold addresses, open
  on every port; the backend sends their containers each entry's domain
  without its port. A domain on a shared CDN address still opens the same
  ports to every other site on it. `AGENTS.md` "Network Isolation" and
  [Container lifecycle](../../architecture/container-lifecycle.md) "Port and
  protocol tuples" describe it.
- Backend: `apps/backend/src/core/container-network.ts`.
  - `ensureEnvironmentNetwork` creates one labelled bridge per environment.
  - `configuredAllowedDomains` is the saved list plus `requiredAgentNetworkDomains`;
    `containerAllowedDomains` is that list as the container's policy takes it.
  - `applyEnvironmentAllowedDomains` applies a saved list in place.
  - `environmentNetworkPolicy` reports `applied`, `pending` or
    `rebuild-required`. A mode change (restricted to full or back) is
    always `rebuild-required`.
- Egress gateway (2026-10-25, item 1): a restricted runtime whose image
  declares `egress-gateway=1` joins the namespace of `<runtime>-egress`
  (`apps/backend/src/core/egress-gateway.ts`, `docker/orkestrator-egress-gateway.sh`),
  which holds `NET_ADMIN`, the environment network, the published ports and
  the firewall. The runtime has no `NET_ADMIN`, so a root terminal cannot
  change the rules. [Container lifecycle](../../architecture/container-lifecycle.md),
  "Egress gateway", describes creation, the start gate, boot verification,
  stop, removal and the orphan sweep. Older images and
  `ORKESTRATOR_EGRESS=in-container` (rollout cap) keep the in-container
  firewall with `NET_ADMIN`, where a root terminal can still change it;
  full-mode containers get neither.
- sudo: `docker/Dockerfile` writes `/etc/sudoers.d/node-firewall` with two
  `NOPASSWD` grants for `node`: `network-policy-entrypoint.sh *` (which now
  runs the firewall step as root before dropping privileges) and
  `run-root-setup.sh *` (only acts when the recorded mode is `full`). The
  `init-firewall.sh` grant is gone. `node` has no sudoers path to `orkroot`.
- One canonical default allowlist (2026-10-22). `DEFAULT_ALLOWED_DOMAINS`,
  `AGENT_NETWORK_DOMAINS_BY_PLATFORM` and `requiredAgentNetworkDomains` live in
  `packages/protocol/src/network-allowlist.ts`; `apps/backend/src/core/constants.ts`
  re-exports the last two.
  - The backend persists `DEFAULT_ALLOWED_DOMAINS` for a new install
    (`defaultConfig`), and the renderer's unloaded config
    (`apps/web/src/stores/configStore.ts`) seeds from the same constant.
  - The firewall's fallback for a container whose `ALLOWED_DOMAINS` is empty
    or absent is `docker/default-allowed-domains`, installed at
    `/usr/local/lib/orkestrator/default-allowed-domains` and read by
    `ork_default_domains` (`docker/firewall-domains.sh`) for both
    `init-firewall.sh` and `update-firewall.sh`. It is generated by
    `bun scripts/generate-default-allowed-domains.ts`
    (`imageDefaultAllowedDomains`): the defaults plus every platform's
    required hosts, because a container with no backend input cannot say
    which platforms are enabled. A missing file allows nothing beyond GitHub.
    The backend sends current images `none` for an empty list, so this
    fallback reaches only containers started outside Orkestrator.
  - `requiredAgentNetworkDomains` stays the only provider-specific addition,
    and a stored user list is never widened on a read.
  - `tests/unit/version-drift.test.ts` fails when the committed file differs
    from the generator's output, when a literal copy of the list reappears in
    the renderer, backend storage or firewall scripts, or when an image host
    (GitHub, npm, Playwright's CDN, the mise runtime hosts) leaves the
    defaults.
  - Narrowed by this change: the image fallback no longer carries the old
    script's extra hosts (`openai.com`, `googleapis.com`, `huggingface.co`,
    `groq.com`, `deepseek.com`, `vercel.com`, `cloudflare.com`, `azure.com`,
    `cdn.jsdelivr.net`, `opencode.ai` and others), and neither does the
    renderer placeholder. Neither was ever applied to a backend-managed
    container on a current image. Images built before this change keep their
    own baked-in fallback.
- Host access: policy 2 allows the host only on the agent-tools port and
  inbound connections only on published ports, all published on
  `127.0.0.1`. `container-host-reachability.ts` (#885) probes that path and
  offers host firewall fixes.
- Credentials: staged inputs and credential syncs go only to providers that
  are enabled, authorized for agent-test profiles and not revoked
  (`providerCredentialsAllowed`, `apps/backend/src/core/portable-input-status.ts`).
  `revoke_provider_credentials` is durable and stops the provider's bridge;
  `restore_provider_credentials` allows it again. The Cursor key is not in a
  staged-inputs container's creation environment; the Anthropic key is a
  staged file there.
- Single-use refresh tokens (2026-10-21): Codex and Grok logins reach a
  container access-only (`restrictCodexAuthSnapshot` and
  `restrictGrokAuthSnapshot` in `packages/protocol/src/login-snapshots.ts`).
  Staging (`accessOnlyLogin` in `portable-inputs.ts`), the restage before
  every `docker start` (`refreshStagedAgentAccountLogins`, now for Codex and
  Grok whether or not an account was added), the account-switch push and a
  push before every Grok bridge start (`syncContainerLogin`) all blank
  the refresh token and drop an expired login. Codex's `last_refresh` is set
  to now, so Codex uses its access token (ten days at issue) until it
  expires instead of trying a refresh it cannot make. The entrypoint
  (`restrict_imported_login`) blanks the refresh token again in the
  container's own copy. That covers containers created while the
  `ORKESTRATOR_PORTABLE_INPUTS=host-mounts` opt-out existed (removed
  2026-10-25) and
  containers that imported a full copy before this change. A copy whose
  access token lapses signs out on its own (Grok 1.0.52 says "Not signed
  in", checked live), and the host login is never touched. The cost: a
  container that imports the host login cannot keep its own `grok login` or
  `codex login` across a restart, because that refresh token is blanked too.
  A container that needs its own login should have that provider's
  credentials revoked. Images older than staged inputs still mount the host
  homes and copy them whole with their old entrypoint. That path is their
  guarded behaviour and stays until they are rebuilt
  ([container lifecycle](../../architecture/container-lifecycle.md#rollout-switches-and-legacy-runtimes)).
- Claude (2026-10-21): containers get the Claude login access-only too
  (`restrictClaudeCredentialsSnapshot`), on every path that used to pipe or
  stage it whole. The keeper and the host-side refresh are described in
  [Container lifecycle](../../architecture/container-lifecycle.md), "Portable
  inputs". The evidence the design rests on:
  - Rotation. Anthropic rotates the Claude.ai refresh token on every refresh,
    and a refresh with a spent one fails with `invalid_grant` ("Refresh token
    not found or invalid") and signs that copy out (anthropics/claude-code
    #24317, #25609, #52202 and #54443, including a captured request whose
    token matched the file on disk). Claude Code 2.1.304's own
    `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` error says the token "was used for this
    attempt and cannot be used again". No Anthropic statement exists (#52202
    asks for one). Not tested with a disposable account: none was available,
    and the host's own could not be spent.
  - Access-only behaviour, from the CLI source (2.1.296 and 2.1.304) and a
    fake login in a 2.23.0 container (Claude Code 2.1.296). A `claudeAiOauth`
    with no `refreshToken` key counts as logged in and never refreshes
    (`no_refresh_token`), and the file is never rewritten, including after
    expiry and after a 401. An empty `refreshToken` is the CLI's dead-login
    marker, so the key is removed instead. A running CLI drops its cached
    login when the file's mtime changes, or after a 401.
  - Host refresh trigger. Claude Code has no refresh-only command and no
    force flag. `claude auth status` attempted a refresh once and not in
    repeat runs, so it is not used. Every `-p` run with a refreshable fake
    login near expiry attempted the refresh, including one for an unknown
    model with `--setting-sources ""` (which kept a user `SessionStart` hook
    from running), `--strict-mcp-config`, `--tools ""` and
    `--no-session-persistence`. The fake access token drew a 401, which also
    forces a refresh, so whether a real, unexpired token is refreshed
    proactively there is from the source, not observed.
  - Cost: a container's own `claude /login` no longer survives a restart while
    Claude credentials are allowed, because its refresh token is stripped too
    (as for Codex and Grok). Revoking the environment's Claude credentials
    keeps it, since nothing is then staged or synced.
- Rotating OpenCode and Pi OAuth refresh tokens (2026-10-21). OpenCode's
  `auth.json` and Pi's `agent/auth.json` hold one login per model provider
  (`{ type: "oauth", access, refresh, expires }`, expiry in milliseconds, or
  an API key). Both CLIs re-read the file before each request: Pi reloads its
  auth storage, and OpenCode's OAuth plugins call `Auth.get`, a file read, on
  every request. An OpenCode server only learns of a provider first signed in
  after it started when it restarts, as on the host. Checked against
  the sources pinned at the time (OpenCode 1.19.0 plugins, Pi 1.2.0 `pi-ai`;
  the pins are now 1.19.5 and 1.4.0, not re-checked, see task 8): Anthropic,
  OpenAI (Codex and ChatGPT), xAI, Kimi and Radius store the new refresh token
  on every refresh, so they rotate (OpenAI's and xAI's are known single-use).
  GitHub Copilot keeps the GitHub OAuth token as `refresh` and only exchanges
  it for a 30-minute Copilot token (OpenCode uses it directly, `expires` 0),
  and Pi's Meta keeps a non-renewable identity token that mints day-long keys.
  `restrictOpenCodeAuthSnapshot` and `restrictPiAuthSnapshot` (same module)
  keep API keys and those two non-rotating logins whole, blank every other
  OAuth login's `refresh` and drop one with less than six minutes left (Pi
  refreshes five minutes early), and drop entries of unknown type (Pi rejects
  the whole file over one). Staging, the restage before every start and a push
  before every OpenCode and Pi bridge start (`syncContainerLogin`, also on a
  reused bridge) apply it. The push merges the host's providers into the
  container's file (`buildMergeContainerProviderAuthCommand`, under Pi's lock
  directory): a provider the user signed in to inside the container keeps its
  own login, and any refresh token the container still holds for a provider
  the host has as rotating OAuth is blanked, even when every host login has
  expired and nothing new is handed over. The merge never takes a lock it
  finds held, however old: Pi's asynchronous refresh holds it for up to 30
  seconds with a 15-second heartbeat, and Pi clears a stale one itself, so a
  held lock only skips that push until the next bridge start. The entrypoint
  blanks rotating refresh tokens again on every start, for the providers the
  mounted host file holds as rotating OAuth; a login made inside the
  container keeps its refresh token, and with no host file the container's
  own file is left alone. Access tokens last hours (Anthropic
  about eight, xAI about six) to days (OpenAI about ten), so a bridge session
  that outlives one signs out until the next bridge start or container start
  picks up the host's refreshed login; the host must have refreshed it, by
  running `pi` or `opencode` there.

## Outstanding work

### Code

1. External egress enforcement. Done 2026-10-25 except its Linux Engine and
   rootless qualification, which moved to Qualification below.
   - [x] Backend wiring (2026-10-25). `createDockerContainer` creates the
     gateway first and the runtime with `--network container:<gateway id>`.
     Ports are published on the gateway; `update-firewall.sh` (live edits,
     `--host-ports`) and the firewall status read run in the gateway
     (`container-network-owner.ts`). Rebuild candidates get their own
     gateway. Stop (`stopRuntimeContainer`), removal (`removeRuntimeContainer`
     at every runtime removal), the deletion ledger
     (`removeEnvironmentEgressGateways`) and a startup orphan sweep all handle
     gateways. A runtime left on a restarted gateway's namespace is stopped
     and started again. Evidence: `tests/egress-gateway.test.ts`,
     `tests/docker-image.test.ts` ("joins its egress gateway"),
     `environment-cleanup.test.ts`, `preview-target-resolver.test.ts`, and
     the live runs under Qualification.
   - [x] Start gate (2026-10-25). The backend starts the runtime only after
     the gateway reports `applied` for its current boot; the gateway's `/run`
     is a tmpfs, so no earlier report can be read. The runtime's root
     entrypoint requires the gateway's rejection of `192.0.2.1:443` before
     anything else runs (`egress-unverified` or `egress-gateway-unavailable`
     otherwise). Docker refuses a runtime whose gateway is not running
     (observed live). Runtimes have no restart policy, so Docker never starts
     either container after a daemon restart; the backend's start path keeps
     the order. A live daemon restart passed on a disposable Linux Engine on
     2026-10-31, with `live-restore` off and on (Qualification).
   - [x] Gateway image (decided 2026-10-25): reuse the workload image rather
     than build a smaller one. See "Assumptions and decisions".
   - [x] `NET_ADMIN` dropped from gateway runtimes and the `init-firewall.sh`
     sudo grant removed from the image (2026-10-25). The root entrypoint runs
     the firewall step for every image. `no-new-privileges` was reconsidered
     and stays off (see "Assumptions and decisions").
   - [ ] Qualify on Linux Engine and rootless. Sibling isolation passed on
     Docker Desktop (2026-10-25); IPv6, a daemon restart and DNS rotation
     passed on a disposable Linux Engine (2026-10-31). See Qualification.
   A plain HTTP proxy was not pursued: it does not constrain direct sockets
   without network enforcement beside it.
2. [x] Change the network mode in place. Decided 2026-10-25 not to build it:
   a mode change stays a rebuild. See "Assumptions and decisions".
3. [x] Keep container MCP OAuth logins signed in (2026-10-25). A Claude push
   now merges into the container's credentials file
   (`buildMergeContainerClaudeCredentialCommand`) instead of replacing it.
   An `mcpOAuth` entry whose refresh token the host was never seen to hold
   (SHA-256 digests only, in memory, up to 8 per server for 128 servers) is
   the container's own login and is kept. A stale host copy is replaced by
   the host's access-only entry. The restart path already left an existing
   file alone. Evidence: `agent-accounts-containers.test.ts` (payload has no
   tokens; the merge script against real files; digest memory across a
   rotation). A live MCP sign-in inside a container is owed (Qualification).
4. [x] Read the host Claude login once per keeper pass (2026-10-25). The pass
   hands its read (`handover`) to every container sync pinned to the same
   account and login generation. A pass that refreshed reads once more,
   after the refresh. Evidence: `container-claude-login-keeper.test.ts` (three
   containers, one read).
5. [x] Re-push access-only logins when the host file changes (2026-10-25).
   `ContainerLoginFileWatcher` polls inode, size and mtime of the host Grok,
   OpenCode and Pi files every 60 s. It runs only while the backend holds
   the writer lease and is stopped at shutdown. On a change, including a
   deletion, it pushes through `syncContainerLogin` (same queue and fences)
   to every running container authorized for that provider. Polling, not
   `fs.watch`: the CLIs replace the file by rename. Whether Grok re-reads
   `auth.json` mid-session is unknown from code and docs; the push keeps the
   file current for the bridge's readiness check and the next Grok process.
   Evidence: `container-login-file-watcher.test.ts`. Live pickup is owed
   (Qualification).
6. [x] Lapsed Codex and Grok guidance (2026-10-25). For a containerized
   environment whose credentials for that provider come from the host,
   `containerSignInGuidance` replaces the sign-in message on the provider's
   readiness snapshots. The message says to run `codex` (or `grok`) on the
   host and restart the environment, and that signing in inside the
   container lasts only until the next restart. It has its own wording when
   an added Codex account is active. The `signIn` route is unchanged.
   Evidence: `container-sign-in-guidance.test.ts`.
7. [x] Host sign-out reaching a container (decided and built 2026-10-25). A
   deliberate host sign-out removes the container's imported copy: a missing
   host file, or one with no login. An expired host login leaves the copy,
   which has lapsed too. Only imported copies (blank refresh token) go;
   API keys and logins made inside the container are kept. For Codex this
   happens at bridge start and terminal open
   (`dropImportedCodexLoginAfterHostSignOut`); for Grok on the push.
   Evidence: `agent-accounts-containers.test.ts` (reconcile matrix, drop
   scripts against real files). See "Assumptions and decisions".

### Qualification

- Egress gateway, production path, on Docker Desktop (done 2026-10-25).
  Docker Desktop 4.96.3 (Engine 29.9.2, linux/arm64), image built from this
  branch (`orkestrator-v2:q0018-egress`), private owner labels, everything
  removed afterwards. Details are in
  [container qualification](../../development/container-qualification.md#egress-gateway-on-docker-desktop-2026-10-25).
  - Live firewall suite: passed behind the gateway and again with
    `ORKESTRATOR_EGRESS=in-container`. Behind the gateway: `node`'s `CapEff`
    0; `orkroot` could not reset `OUTPUT`, flush the rules or flush the set;
    `sudo -n init-firewall.sh` was refused; ports were published through the
    gateway; a gateway restart failed closed and recovered.
  - Live network suite: C22 sibling and host isolation behind the gateway.
  - Live readiness suite: the gateway fault (no firewall script) refused the
    start with the runtime never started.
  - Live replacement: a restricted rebuild with a fixed host port moved to a
    new gateway on the same port; the whole replacement and rebuild-fault
    suites passed in that run.
  - `scripts/qualify-egress-gateway.sh orkestrator-v2:q0018-egress`, with its
    sudo checks updated for the removed grant: every check passed. The
    gateway applied its firewall 3.8 s after `docker start` and used 1.8 MiB
    and 3 PIDs.
- Egress gateway on Linux Engine and rootless (high; on by default for
  restricted runtimes on a current image). Still owed: a rootless daemon
  (task 2), and the decision whether the CI runs below count as the rootful
  pass (task 1). On a rootless host run the live suites against an image
  built there. Until both are recorded, `ORKESTRATOR_EGRESS=in-container`
  restores the in-container firewall.
  - Linux Engine CI (`container-live-qualification.yml`, recorded
    2026-10-31 from `gh run view`). Run 40999226305 (head `79c35c0b`,
    2026-10-30, Engine 28.0.4, image capabilities including
    `egress-gateway=1,network-policy=3`) passed every step on `ubuntu-24.04`
    and `ubuntu-24.04-arm`: replacement 12/12, network 4/4 (C22 behind the
    gateway), firewall 2/2 (C23 and tuples, `CapEff` 0, tampering refused,
    gateway restart), readiness 9/9 (a gateway that cannot apply its
    firewall refuses the start) on each runner. Run 40338400817 (`e8306626`,
    2026-10-26) passed the same steps, and PR runs 40746551838 (2026-10-28)
    and 40799843615 (2026-10-29) passed too. Run 40409285999 (`e53ea683`)
    failed only C14 legacy migration in the replacement suite. The weekly
    run 40304582303 (`main`, 2026-10-26) failed in the lifecycle step.
  - IPv6, daemon restart and DNS rotation, on a disposable Linux Engine
    29.9.2 (2026-10-31): see task 3's result and
    [container qualification](../../development/container-qualification.md#egress-gateway-conditions-on-linux-engine-2026-10-31).
    The workflow now also runs the IPv6 and DNS rotation cases
    (`container-live-egress-conditions.test.ts`, with
    `ORKESTRATOR_LIVE_IPV6_NETWORK=1`). The daemon-restart case runs only
    with `ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND`, against a disposable
    daemon.
- External egress prototype, run on 2026-10-22 on Docker Desktop 29.7.2
  (aarch64) with image `orkestrator-v2:latest` (= `ghcr.io/orkestrator-ai/orkestrator-v2:2.23.0`)
  and this change's firewall scripts bind-mounted:
  `scripts/qualify-egress-gateway.sh orkestrator-v2:latest`. All 28 checks
  passed:
  - The workload's effective capabilities were `0000000000000000`.
    Policy 3 held from the gateway: HTTPS to an allowed domain and the one
    extra port an entry named worked, another port on that address and a
    domain off the list were rejected, and Git over SSH reached GitHub.
  - As root in the workload, `iptables -P OUTPUT ACCEPT`, `iptables -F` and
    `ipset flush allowed-domains` all failed, `sudo init-firewall.sh` as
    `node` failed, and an unlisted domain stayed blocked afterwards.
  - `update-firewall.sh --add` and `--remove`, run in the gateway, opened and
    closed a domain for the workload.
  - The host reached the workload's port published on the gateway; the
    workload reached the named host-service port on
    `host.docker.internal` and not another host port.
  - A workload restart kept the rules. A gateway restart left the running
    workload with only loopback (fails closed); once the gateway re-applied
    its firewall, a workload restart restored the same policy.
  - The gateway applied the firewall 0.8 s after `docker run`, and used
    about 1.7 MiB and 3 PIDs (bash, sleep and the refresher). The packet path
    is the same namespace and rules as today, so data-path overhead is nil
    by construction; nothing was measured under load.
  - Not covered: Linux Engine, rootless, IPv6 (the Desktop network had none),
    sibling isolation, DNS rotation, Docker daemon restarts.
- Container-made MCP login and renewal pickup, live (medium; items 3 and 5).
  In a container terminal, sign in to an MCP server with `claude /mcp`. Then
  confirm with `jq 'keys'` on `~/.claude/.credentials.json` (never printing
  tokens) that the login survives a keeper push and a container restart. For
  Grok, check whether a running session picks up a host renewal without a
  bridge restart. This needs a fresh host Grok login; the host's expired on
  2026-10-23. OpenCode and Pi pickup of a pushed renewal, and the sign-out
  removal of item 7, fold into the OpenCode and Pi item below.
- Claude host refresh and mid-session pickup, live (high; on by default).
  Nothing has yet run `refreshHostClaudeLogin` against a real login, because
  doing so spends the host's refresh token. On a host or disposable account
  whose access token is inside its last five minutes (the keeper's
  `TOKEN_REPLACEMENT_LEAD_MS`), with a Claude bridge
  running in a container: confirm the keeper's `-p` run renews the host login
  (new `expiresAt`, no model request billed, the user's `claude` still signed
  in afterwards), that the renewal reaches the container, and that the
  running container CLI uses it without a restart. Also confirm a run with
  more than five minutes left changes nothing. Re-check the trigger after
  each Claude Code upgrade.
- Claude access-only run on 2026-10-21. Host Claude Code 2.1.304 (Keychain
  login); container image `ghcr.io/orkestrator-ai/orkestrator-v2:2.23.0`
  (Claude Code 2.1.296) on Docker Desktop 29.8.2 (aarch64), with this
  change's `docker/entrypoint.sh` bind-mounted. One disposable container,
  `ork-live-0681-claude-access`, full network mode, removed afterwards; the
  CLI probes ran in throwaway `ork-live-0680-claude-probe` containers with
  fake tokens only. No profile or other environment was touched.
  - Host Keychain item and `~/.claude/.credentials.json`: SHA-256 prefix and
    modification time recorded before and after. Both were unchanged.
  - Entrypoint migration: a fake full-shape credential on the
    `/claude-config` mount was copied with its refresh token removed (mode
    600, sentinel absent).
  - `accessOnlyLoginText("claude", …)` over the real host login, pushed with
    the production stdin command: no `refreshToken` key, no MCP refresh
    tokens, the host refresh token nowhere in the payload.
  - In the container, `claude auth status` reported a Claude Max login and
    `claude -p … --model haiku` answered "pong" (exit 0). The credential file's
    hash and mtime were unchanged afterwards and it still had no refresh token.
  - The in-place restrict command removed both refresh tokens from a fake
    file (mode 600). The `oauthAccount` command replaced the identity, kept
    the other 25 keys of `~/.claude.json`, and `claude auth status` then named
    the new (fake) email.
  - Skipped: the host refresh and a mid-session token pickup (see above).
- OpenCode and Pi past expiry with live OAuth logins (medium). The
  2026-10-21 run below had none: the host's OpenCode holds API keys only, and
  Pi's only OAuth login (OpenAI) had expired, so staging rightly withheld it.
  Still so on 2026-10-25: OpenCode holds two API keys, and Pi's OpenAI OAuth
  login is expired.
  With a fresh host Pi or OpenCode OAuth login (Anthropic or OpenAI), check in
  a container that a turn works with the access-only copy, that it signs out
  alone past `expires` (or with `expires` edited in the container's copy),
  that a bridge restart after a host `pi`/`opencode` run signs it back in, and
  that the host file's hash changes only when the host itself refreshes.
- Run on 2026-10-21 (rotating OpenCode and Pi tokens). Container image
  `ghcr.io/orkestrator-ai/orkestrator-v2:2.23.0` (OpenCode 1.19.0, Pi 1.2.0,
  matching the pins) on Docker Desktop 29.8.2 (aarch64), full network mode,
  with this change's `docker/entrypoint.sh` bind-mounted over the image's. One
  disposable container, `ork-live-0690-oc-pi`, removed afterwards with its
  temporary data directory. No profile or other environment was touched.
  - Host `~/.local/share/opencode/auth.json`, `~/.pi/agent/auth.json`,
    `~/.grok/auth.json`, `~/.codex/auth.json` and `~/.claude/.credentials.json`:
    SHA-256 prefix and mtime recorded before and after. All unchanged.
  - `stagePortableInputs` for OpenCode and Pi from the real host home: the
    OpenCode file was staged with its two API keys unchanged. Pi's file was
    withheld (`login-withheld: 1`): its only login, OpenAI OAuth, had expired.
  - Boot reached "Container Ready". `opencode auth list` showed both keys, and
    `opencode run -m opencode/big-pickle` answered "pong" with the Zen key.
  - Migration from before the change, fake tokens: a full-shape Pi file
    (Anthropic OAuth, Copilot OAuth, OpenRouter key) written into the
    container, then the container restarted. The entrypoint blanked
    Anthropic's refresh token and kept Copilot's and the key. (The
    entrypoint has since been narrowed to the providers the mounted host
    file holds as rotating OAuth; a unit test covers both cases.)
  - `pi -p --model anthropic/claude-haiku-4-5` with that expired, access-only
    login exited 1 with "OAuth refresh failed for anthropic" (Anthropic
    answered 400 to the empty token) and left the file unchanged.
  - The pre-bridge merge command, run with `docker exec -i` in the image:
    the host's (fake) Anthropic login replaced the container's, a stale full
    copy of an OpenAI Codex login had its refresh token blanked, a login the
    container made itself (Kimi) and an API key were kept, and no lock or
    temporary file was left.
- Grok past expiry with a live login (medium). The 2026-10-21 run below could
  not use a real Grok login: the host's access token had expired about eight
  hours earlier, so staging rightly withheld it. Repeat on a host whose Grok
  token is fresh. Run a Grok tab in a container past the access token's
  expiry (about six hours, or edit `expires_at` in the container's copy).
  Confirm that the container signs out on its own, that a bridge restart
  after a host `grok` run signs it back in, and that the host's `auth.json`
  hash changes only when the host itself refreshes. Tried again on
  2026-10-21 at 07:38Z and 07:58Z: still skipped, because the host Grok access
  token expired at 2026-10-20T16:24:55Z and refreshing it would have spent the
  host's own refresh token. The profile launcher withheld the login and the
  opt-in live spec (`grok-container-login.spec.ts`) skipped explicitly. The
  Codex half of the same property passed live that day (next item).
- Codex past expiry, run on 2026-10-21 (details in
  [0019-container-platform-qualification.md](0019-container-platform-qualification.md),
  "Results, 2026-10-21"). With the container's own access token past its
  `exp`, Codex 0.162.1 tried a refresh with the blank refresh token, OpenAI
  answered 400 `empty_string`, and turns failed. The container held no
  refresh token, so nothing on the host could be spent; the host
  `~/.codex/auth.json` and `~/.grok/auth.json` hashes and mtimes were
  unchanged. A restart restaged the host login and signed it back in. The
  bridge reported that sign-out as "temporarily unavailable" until this
  change; it now reports `needs-auth`.
- Run on 2026-10-21 (single-use refresh tokens). Host Grok 1.0.62; container
  image `ghcr.io/orkestrator-ai/orkestrator-v2:2.23.0` (Grok 1.0.52,
  codex-cli 0.162.1) on Docker Desktop 29.8.2 (aarch64), with this change's
  `docker/entrypoint.sh` bind-mounted over the image's. The run used one
  disposable container, `ork-live-0600-grok-fix`, in full network mode,
  removed afterwards. No profile or other environment was touched.
  - Host `~/.grok/auth.json` and `~/.codex/auth.json`: SHA-256 prefix and
    mtime recorded before and after. Both were unchanged.
  - `stagePortableInputs` for Codex and Grok, from the real host home into a
    temporary data directory: Codex `auth.json` was staged with an empty
    refresh token. Grok was withheld (`login-withheld: 1`) because the host
    access token had expired.
  - The entrypoint boot reached `ready`. The container's Codex `auth.json`
    had an empty refresh token, a `last_refresh` seconds old and mode 600.
    `codex login status` reported "Logged in using ChatGPT", and
    `codex exec --skip-git-repo-check --sandbox read-only` answered "pong"
    (exit 0). The refresh token was still empty afterwards.
  - Migration from before the change: a fake full-shape Grok login (fake
    access and refresh tokens) was written into the container's
    `~/.grok/auth.json`, then the container was restarted. The entrypoint
    blanked the refresh token and kept the access token.
  - `grok -p` with that access-only fake login exited 1 with "Not signed in"
    within the 90-second limit, and left the file with no refresh token.
  - Skipped: a real Grok call, because the host is signed out of Grok (see
    above).
- The Desktop and arm64 packet matrix and live credential rotation are
  tracked in [0019-container-platform-qualification.md](0019-container-platform-qualification.md).
  Allowed provider access, blocked destinations, host callbacks, sibling
  isolation and firewall initialisation failure passed live on Docker Desktop
  on 2026-10-25, behind the egress gateway (above). For the gateway, DNS
  rotation and IPv6 passed on a disposable Linux Engine on 2026-10-31
  (task 3); 0019's own packet matrix tracks its remaining platforms.
- Policy 3 port tuples ran live on Docker Desktop (Engine 29.9.2, arm64) on
  2026-10-25, through the egress gateway and with the in-container
  firewall. C22 showed that an allowed domain answers on 443, another port on
  the same address is rejected, and Git over SSH reaches GitHub. C23 covered
  per-port edits and revocation, and the TCP/UDP echo-peer tuple test (an
  established flow removed and another kept) passed, so that kernel supports
  `hash:net,port`. A rootless kernel passed the tuples on 2026-10-25 with
  `ip_set`, `xt_set` and `nf_tables` loaded
  ([container qualification](../../development/container-qualification.md#rootless-linux-host-2026-10-25));
  the gateway's own rootless checks are task 2. The
  earlier attempt on Docker Desktop 29.8.1 never started a container
  (`/tmp/orkestrator-test-run.0g2KQN/live-firewall.log.gz`). The command:

  ```bash
  RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> mise run test:logged -- --name live-firewall -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/container-live-firewall.test.ts --parallel=1
  ```

## Constraints and rationale

- Default ports (decided 2026-10-15): TCP 443 for allowed domains, TCP 443 and
  22 for GitHub's ranges. Everything on the default lists is HTTPS on 443, so
  anything else needs a `host:port` (or `host:port/udp`) entry; plain HTTP
  (80) and SSH to other Git hosts are not defaults. Lists that relied on
  another port are not rewritten; the network status and settings help say
  what applies.
- Never claim that IP allowlisting prevents exfiltration. Shared CDN
  addresses, allowed services and DNS remain channels.
- Never fall back to the shared default bridge when the environment network
  cannot be created; that is an explicit error.
- No allow-all or empty window during a refresh: build the next set beside
  the live one, swap it in, then revoke tracked connections of removed
  entries.
- IPv6 stays dropped unless equivalent IPv6 enforcement is implemented and
  tested.
- Keep the restricted-mode sudo policy exact. Never add blanket sudo, never
  mount the Docker socket, and do not remove sudo capabilities or enable
  `no-new-privileges` before the privileged firewall initialisation has
  actually been replaced.
- Do not describe a root workload as unable to change its firewall.
- Published ports stay on loopback and authenticated.
- A container never holds a refresh token it shares with the host or another
  container when that provider's refresh tokens are single-use or rotating. It
  gets the access token, re-read from the host on start, and signs out on its
  own when that expires. A refresh token that is reused rather than rotated
  (GitHub Copilot, Pi's Meta) may be copied, like an API key. Only the host
  refreshes through the provider's own CLI; Orkestrator never calls a token
  endpoint or writes a host credential store itself, and an agent-test profile
  never refreshes the host at all.
- Credentials go only to enabled, authorized, non-revoked providers.
  Revocation is recorded before anything else, so an interrupted revoke still
  gates staging and syncs. Never promise that removal retracts a credential a
  workload already read, and never revoke an account-wide key.

## Open questions

- External enforcement (answered 2026-10-22, built 2026-10-25): a per-runtime gateway that
  owns the network namespace, which the workload joins. The reverse (a
  sidecar joining the workload's namespace) was rejected: a workload restart
  would get a fresh namespace with no rules and run unrestricted until the
  sidecar re-applied them. A routing gateway on the environment network
  would need the workload's default route changed, which itself needs
  `NET_ADMIN`.
- How far to narrow root-terminal `NET_ADMIN` in restricted mode (answered
  2026-10-25). A gateway runtime has none, so a root terminal cannot change
  the firewall. A deliberate firewall change is `docker exec --user root`
  into the gateway, which is what the backend does. Runtimes with an
  in-container firewall keep the documented behaviour until they are rebuilt.

## Assumptions and decisions

Recorded 2026-10-25, while implementing items 1–7.

- **Gateway image.**
  - Options: a new minimal image (bash, iptables, ipset, dig, curl,
    conntrack); a multi-stage target of the same Dockerfile; or the workload
    image itself.
  - Chosen: the workload image, same image id. It is already on the daemon,
    so it costs no disk or pull, and its firewall scripts always match the
    runtime's. Measured on 2026-10-22 at about 1.7 MiB and 3 PIDs.
  - Pros: no second artifact to build, publish, pull or version-match; no
    image or registry change.
  - Cons: the gateway has the whole workload toolset available as root. Only
    the backend execs into it and nothing in the workload can reach it, so
    the extra surface is reachable only by someone who already controls the
    daemon. Revisit if gateways ever run on a daemon without the workload
    image.
- **One gateway per runtime, not per environment.**
  - Options: per runtime or per environment.
  - Chosen: per runtime. A rebuild candidate gets its own, and a recovery
    copy keeps its own, stopped.
  - Why: a runtime references its gateway by id, immutably. With one shared
    gateway, a candidate and its source could not run in turn, and restoring
    a copy would depend on a gateway that a newer runtime had replaced.
  - Pros: every runtime starts and stops independently.
  - Cons: retained copies keep a small stopped container each.
- **Gateway labels.**
  - Chosen: no app label and no `environment-id`; their own owner, role,
    workload and environment labels instead.
  - Why: every existing listing of runtimes (cleanup review, usage, recovery
    copies, operation reconciliation, OOM attribution) ignores gateways
    without a change.
  - Pros: no listing needs a gateway case.
  - Cons: gateways are invisible to the cleanup review, so they need their
    own removal paths: removal with their runtime, the ledger step and the
    startup orphan sweep.
- **Start gate.**
  - Options: trust Docker's start order; poll the gateway's report; also
    verify from the runtime.
  - Chosen: both of the last two. The backend waits for `applied` from a
    tmpfs report, and the runtime's root entrypoint probes `192.0.2.1:443`
    (TEST-NET-1) and requires "No route to host", the gateway's
    `icmp-admin-prohibited` rejection.
  - Why: an unrestricted Desktop namespace timed out on that address (rc
    124), so a timeout or a success means "not enforced", and "Network is
    unreachable" means the gateway has gone.
  - Cons: an upstream network that itself sends host-unreachable for
    TEST-NET would satisfy the probe, so the backend gate stays the primary
    one.
  - Docker restart policies: runtimes have none, so Docker never starts
    either container on its own.
- **Firewall step moved into the root entrypoint, for every image.**
  - Options: keep `sudo init-firewall.sh` for in-container runtimes, or run
    the firewall from the root entrypoint before privileges drop.
  - Chosen: the root entrypoint.
  - Pros: the `init-firewall.sh` grant is removed for every runtime, not only
    gateway ones.
  - Cons: the firewall now runs before the node entrypoint, so the root
    entrypoint opens this boot's `initializing` record and hands its boot id
    over (`ORKESTRATOR_BOOT_ID`). Readiness keeps one boot id from the
    firewall step to `ready`, as the held-boot readiness tests require. Node
    can still re-run the root entrypoint through its remaining grant, which
    re-applies the recorded policy. That is the same power the removed grant
    gave.
- **`no-new-privileges` stays off.** The image's entrypoint is `sudo
  network-policy-entrypoint.sh` running as `node`, which the flag would
  break. Starting runtimes as root instead would make every `docker exec`
  without `--user` run as root. A gateway runtime has no `NET_ADMIN` to
  regain, so the remaining sudo grants give root only inside a namespace
  root cannot change.
- **Rollout cap.** `ORKESTRATOR_EGRESS=in-container` keeps the old topology
  on a gateway-capable image, like `ORKESTRATOR_NETWORK_POLICY=2`. It is
  listed in the lifecycle doc's rollout switches, and is to be removed once
  Linux Engine and rootless pass.
- **Item 2, in-place mode change: not built.**
  - Options: switch a running gateway between restricted and full; or keep
    "mode change is a rebuild".
  - Chosen: keep the rebuild.
  - Why: the mode is recorded root-owned, once, in the runtime, and
    `run-root-setup.sh` trusts that record. Changing it in place would need
    a privileged rewrite path into the runtime, which the design
    deliberately lacks. A full-mode runtime also has no gateway to restrict
    later.
  - Pros: no new privileged path.
  - Cons: the user waits for a preserving rebuild.
- **Item 3, container MCP logins.**
  - Options: (a) the keeper refreshes MCP logins on the host through the
    CLI; (b) keep container-owned MCP logins separate.
  - Chosen: (b). No CLI command refreshes an MCP token without launching
    every configured MCP server, and (a) would stretch "only the host CLI
    refreshes its own login".
  - Pros: no host or shared refresh token ever reaches a container.
  - Cons: host-imported MCP logins still lapse with their access token
    unless the host uses that server; the user signs in once inside the
    container instead. Digests are remembered only since backend start.
- **Item 4.** Built without measuring first, since the change was a few
  lines.
- **Item 5.** Polling rather than `fs.watch`, because the CLIs rename over
  the file. A separate watcher rather than the Claude keeper, because
  Claude's macOS login lives in the Keychain and has no file to poll.
- **Item 6.** The guidance is rewritten in the backend rather than in the
  bridges, so it works with existing images. Turn-time auth notices are left
  as they are.
- **Item 7.**
  - Options: remove the copy on every restage that stages nothing; or leave
    it to expire and document that.
  - Chosen: remove it, only on a deliberate host sign-out (no file, or no
    login), and only the imported copy (blank refresh token).
  - Pros: honours a host sign-out without destroying the container's own
    login.
  - Cons: after a restart, a container-made login also has a blank refresh
    token, so a later host sign-out removes it too.

Recorded 2026-10-31, while doing tasks 3 and 9.

- **Where the three conditions ran.**
  - Options: the host's own daemon; a second `dockerd` on the host; a
    `docker:dind` daemon in a privileged container; a disposable VM.
  - Chosen: `docker:29-dind`, with its own volume and `daemon.json`, reached
    through a socket in a private directory and restarted by a supervisor
    loop. That gave the same Engine version as the host (29.9.2).
  - Why: the host daemon runs other environments and must not be restarted
    or reconfigured. A second host `dockerd` needs root and shares the host's
    network namespace and firewall. No VM was available.
  - Pros: a real daemon restart and a real IPv6 default, with nothing on the
    host changed (the host's `net.ipv6.conf.all.forwarding` stayed 0).
  - Cons: a nested daemon is not a user's machine. Its "host" is the dind
    container, so a test that needs a host listener (the live network suite,
    or the firewall suite's published-port check) cannot run against it
    unchanged. The firewall suite was therefore also run on the host daemon.
- **IPv6 coverage in CI.**
  - Options: run the IPv6 case only on daemons whose defaults enable IPv6;
    or let it attach its own IPv6 network to the gateway when the operator
    opts in.
  - Chosen: both. The test uses the daemon default when there is one, and
    with `ORKESTRATOR_LIVE_IPV6_NETWORK=1` it attaches a ULA network
    instead. The CI workflow sets the variable. Without either, it logs "IPv6
    not covered" rather than passing silently.
  - Why: creating an IPv6 network can switch on the host's IPv6 forwarding,
    which a developer's live run must never do unasked. Hosted runners are
    disposable.
- **Environment networks still do not pass `--ipv6=false`.**
  - Options: pass it, so a daemon default never gives the network IPv6; or
    leave network creation as it is.
  - Chosen: leave it. The namespace owner's sysctl was shown to keep every
    interface, including one attached later, without IPv6, and the firewall
    drops IPv6 behind that. The comment in `container-network.ts` and the
    lifecycle doc now say a daemon default can still give the network IPv6.
  - Pros: no change to network creation or adoption, and no dependence on
    how each Engine version handles `--ipv6=false` against
    `default-network-opts`.
  - Cons: such a daemon still allocates an IPv6 subnet that nothing uses.
- **DNS rotation pass criterion.**
  - Options: a real CDN domain observed for more than one TTL and for six
    hours; or a resolver the test controls, inside the gateway, rotating
    peer addresses on demand, with expiry brought forward by editing the
    address record.
  - Chosen: the controlled resolver. It drives the production refresh
    (`update-firewall.sh --refresh`), real `dig`, `ipset` kernel timeouts and
    `conntrack`, deterministically and in seconds, and it found the
    revocation gap. A real-CDN six-hour soak was not run. It would add only
    the observation that a real CDN rotates within its TTL.
- **Revoking connections to addresses the kernel expired.**
  - Options: (a) record the set's members at each application and include
    them in the "before" side of the next diff; (b) sweep every tracked
    connection at each refresh and re-test it against the set; (c) schedule
    a refresh at the earliest carried expiry instead of relying on the
    kernel timeout.
  - Chosen: (a). It reuses the existing per-tuple revocation, so it revokes
    exactly what a removal would.
  - Pros: small, root-only state (`/var/lib/orkestrator/allowed-entries`),
    bounded by the existing revocation cap, and an image without the record
    behaves as before.
  - Cons: the connection is cut at the next refresh, up to 30 minutes after
    the expiry, not at the expiry itself. New connections are refused from
    the expiry on. (b) would have to repeat every other accept rule (DNS,
    host services, ingress) and could cut legitimate flows. (c) adds
    scheduling state and still needs (a) when a refresh is late.
  - Only images built from this change carry the fix; existing runtimes get
    it on rebuild.
- **Task 1 stays open.** The CI runs are recorded, but whether they count as
  the rootful qualification is task 1's own decision, and this delegation
  left task 1 open.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md),
  [0109-rootless-linux-runtime-gaps.md](0109-rootless-linux-runtime-gaps.md)
  (staged inputs and host access on rootless),
  [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md) (the container
  preview relay), [0040-mcp-environment-delivery.md](../mcp/0040-mcp-environment-delivery.md)
  (network and auth for MCP outside the backend host).
- [Container lifecycle](../../architecture/container-lifecycle.md): "Environment
  networks", "Agent tools reachability" and "Portable inputs".

## Replaces

- `docs/improvements/containers/plan/09-environment-networks-and-egress-policy.md`
  (unfinished items: tuples, canonical defaults, external egress, privilege
  boundary, in-place mode change)
- `docs/improvements/containers/plan/08-portable-inputs-and-credential-lifecycle.md`
  (credential and revocation constraints)
- `docs/improvements/containers/plan/00-index.md` (networking and privilege
  decisions)
- `docs/improvements/containers.md` (finding 5 and its egress-proxy
  recommendation)
- `docs/reviews/2026-09-15-fable-review.md` (the `NET_ADMIN` residual; its
  sudo findings are fixed)
