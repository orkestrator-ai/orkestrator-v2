# What the gateway's name checks still let through

Carried from the security report's S-0100 file (finding M12) when it was closed on 2026-11-05. The egress gateway now checks TLS SNI, HTTP Host and DNS names against the allowlist; these are the channels and rough edges it leaves, recorded so they are decided rather than forgotten.

## Task analysis

Analysed 2026-11-05 against `main` at `704809a20`. Task 4 built 2026-11-06 on `main` at `c1724ab74`.

### Tasks

1. **Names hidden inside TLS**: an encrypted ClientHello and domain fronting. Status: open.
2. **Requests after the first on a connection**: kept-alive HTTP/1.1 and HTTP/2 connection reuse. Status: open.
3. **UDP entries and other protocols**: QUIC and named-port protocols that are not TLS or HTTP. Status: open.
4. **Show the user what was refused**: counts of refused connections and DNS queries since boot, in the Network section. Status: done (2026-11-06).
5. **A refused upstream now looks like a reset**: the client's handshake completes with the daemon first. Status: open.

### 1. Names hidden inside TLS

**Problem.** The daemon reads the ClientHello's server name. With an encrypted ClientHello (ECH) the visible name is the outer one, so a client can put an allowed name outside and an attacker's tenant on the same front inside. With domain fronting the SNI is allowed and the HTTP Host inside TLS names another tenant.

**Context.** The check deliberately does not decrypt anything. Chrome and Playwright send a GREASE ECH extension on every connection, so refusing any ClientHello with the ECH extension would break them.

**Investigation.** Not exploited live: that needs an attacker-controlled tenant on an allowed front, which S-0100's live checks were not allowed to contact.

**Decisions.**

- **What to do about it?**
  - **Document it and leave it (recommended).** The settings help, README and `docker/AGENTS.md` already say so.
    - Pros: no interception, no CA in the container, no breakage.
    - Cons: the channel stays for a determined agent.
  - **Terminate TLS in the gateway with a per-environment CA.**
    - Pros: sees the real Host and every request.
    - Cons: a CA the workload must trust, every pinned client breaks, the gateway sees all content; a far larger component.

### 2. Requests after the first on a connection

**Problem.** Only the first request of a plain HTTP connection is checked, so a kept-alive connection can send a second request with another Host. An HTTP/2 client may reuse one TLS connection for another name its certificate covers.

**Context.** `http_host` in `docker/orkestrator-egress-filter.pl` parses one request head; the relay then copies bytes.

**Investigation.** Behaviour is as designed and documented in `container-lifecycle.md`.

**Decisions.**

- **Check every HTTP request?**
  - **No, leave it (recommended).** Plain HTTP is rare on named ports, and the same server answered the first request.
    - Pros: no HTTP parser on the data path.
    - Cons: a client that keeps a connection open can reach another tenant on the same plain-HTTP front.
  - **Parse every request head on plain HTTP.**
    - Pros: closes the second-request case.
    - Cons: needs body framing (chunked, content-length, upgrades) in the relay.

### 3. UDP entries and other protocols

**Problem.** A `host:port/udp` entry (QUIC, for example) and a protocol that is neither TLS nor HTTP on a named port are allowed by address only.

**Context.** The filter ACCEPT rule for UDP does not require the daemon's mark; non-TLS bytes on a port other than 443 are relayed.

**Investigation.** Covered by the live suite only for the address case (the fixture's banner service).

**Decisions.**

- **Narrow them?**
  - **Leave them, documented (recommended).** UDP entries are opt-in per port.
    - Pros: databases and QUIC keep working.
    - Cons: those entries keep the shared-address channel.
  - **Read the QUIC Initial's SNI.**
    - Pros: covers HTTP/3.
    - Cons: QUIC Initial decryption in the daemon, for a rarely configured entry.

### 4. Show the user what was refused

**Problem.** A refused name shows up only as the client's error (a TLS `access_denied` alert, a 403 naming the gateway, or DNS REFUSED with EDE 18). Nothing tells the user which names an agent was refused, so a missing allowlist entry is found by reading the agent's error.

**Context.** The daemon deliberately logs no names: a refused name can carry the data an agent tried to send (`<secret>.attacker.tld`).

**Investigation.** Built with the recommended option (counts only), 2026-11-06. The daemon counts every connection it refuses (a name off the list in the ClientHello or Host, another protocol on TCP 443, a first write that never completed) and every DNS query it answers REFUSED, over UDP and TCP. It writes `{"refusedConnections":N,"refusedQueries":M}` to `/run/orkestrator-firewall/egress-refusals.json` at most once a second when a count moved; a restarted worker reads it back, and a new gateway boot (fresh `/run`) starts at zero. The backend reads it in the same `docker exec` as the firewall report and returns `effective.refusals` only beside `egressFilter: enforced` (`null` for an image before the counts), and the Network section says "Since the gateway started, its name checks have refused 3 connections and 3 DNS queries", adding that the gateway does not record which names and that the agent's own error names the host. `init-firewall.sh`'s boot checks ask for names off the list on purpose (the `.invalid` DNS and SNI probes, and `example.com`), so they run under a quiet marker the daemon honours for at most two minutes. Unit tests: `tests/unit/egress-filter-daemon.test.ts` ("refusal counts"), `tests/unit/firewall-egress-filter.test.ts`, `apps/backend/tests/container-network.test.ts` and `EnvironmentNetworkPolicyStatus.test.tsx`. Live evidence is under [Assumptions and decisions](#assumptions-and-decisions). The Network section reads the counts once when it opens; [7510](7510-refusal-counts-refresh.md) records refreshing them while it is open.

**Decisions.**

- **What to show?**
  - **Counts only, in the firewall report (recommended).** Refused connections and queries since boot, shown in the Network section.
    - Pros: content-free; tells the user to look.
    - Cons: does not say which name to add.
  - **The refused names, truncated, in a root-only file the user can open.**
    - Pros: tells the user exactly what to allow.
    - Cons: may hold the data being exfiltrated; needs bounds and a retention rule.

### 5. A refused upstream now looks like a reset

**Problem.** A connection to an allowed address completes its TCP handshake with the daemon before the daemon reaches the upstream, so a closed upstream port now appears to the client as a connect followed by a reset, not as "connection refused".

**Context.** The redirect delivers the SYN to the daemon's listener; the kernel answers it before `accept`.

**Investigation.** Seen in design; the existing live suites passed (readiness 9/9, egress conditions and network apart from the failures in [6103](6103-live-suite-failures-seen-during-s0100.md)).

**Decisions.**

- **Change it?**
  - **Leave it (recommended).** Clients treat both as a failed connection.
    - Pros: no TPROXY or delayed-accept machinery.
    - Cons: a health check that distinguishes refused from reset reads differently.
  - **Connect upstream first and accept only on success (TPROXY with `IP_TRANSPARENT`).**
    - Pros: refusals stay refusals.
    - Cons: policy routing in the gateway and a daemon that can set `IP_TRANSPARENT`.

## Assumptions and decisions

### Task 4: what counts as a refusal (2026-11-06)

Every connection the daemon closes through its refusal path is one refused connection: a name off the list (TLS or HTTP), a ClientHello or request head it cannot read, another protocol on TCP 443, and a connection whose first bytes never completed within their limit. Every query answered REFUSED (a name off the list, or an opcode other than QUERY) is one refused query. Not counted: a direct connection to the daemon's own ports, a connection dropped at the 256-connection cap, an upstream that did not answer, and malformed DNS packets the daemon ignores. Those are not answers to a name. A client that retries (getaddrinfo asking A and AAAA, or a resolver trying its search list) is counted once per query it sent, which is what the daemon saw.

### Task 4: keeping the counts content-free (2026-11-06)

Options: two numbers only (chosen); a per-kind breakdown (TLS, HTTP, other, DNS); the refused names in a root-only file. The breakdown would say slightly more but nothing a user acts on differently, and the names are the channel the checks exist to close. The counts file holds exactly two integers in a fixed shape; the backend accepts only that shape (two non-negative safe integers, at most 256 bytes) and the daemon reads back only that shape when its worker restarts, so nothing else can ride along. The live run greps the gateway's `/run`, `/etc`, `/tmp`, `/var/log` and `/root` and its Docker log for the refused label and finds nothing.

### Task 4: the firewall's own boot checks (2026-11-06)

Options: a quiet marker held by `init-firewall.sh` during its checks (chosen); excluding the probe names inside the daemon; resetting the counts after boot. Name exclusion cannot cover `example.com`, which a user may also be refused for real, and a reset would wipe real counts when the firewall is re-initialized on a live gateway. The marker sits in the gateway's root-only `/run` (a workload cannot create it) and only mutes counting, never checking; one older than two minutes is ignored, and an `EXIT` trap removes it if a check fails.

### Task 4: live run on beelink (2026-11-06)

Host beelink (Arch Linux, kernel 7.1.8, x86_64), host Docker Engine 29.9.2 rootful; Docker, its networks and the host firewall were not restarted, reconfigured or pruned. Image `orkestrator-v2:qual-6102-a891cd1a`, built here from commit `a891cd1a2` with the capability arguments from `scripts/docker-image-build-args.ts` and the label `orkestrator-test-run=todo-6102-refusals` (BuildKit served every layer up to the changed scripts from cache). The host's address pools are full, so both runs used the test-only Docker shim of [7041](../../development/container-qualification.md#exhausted-docker-pools-and-historical-probe-network-trace-2026-11-06) (`ORKESTRATOR_QUALIFICATION_DOCKER` with `apps/desktop/scripts/dev/docker-qualification-bin` on PATH), with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`. No profile, provider turn or credential was used.

The new case in `apps/backend/tests/container-live-egress-filter.test.ts` ("the firewall report counts refused connections and queries since boot, and keeps no name") passed alone (1 pass, 21 expectations, 13 s) and in the whole file (5 pass, 1 skip — the older-image case, which needs `ORKESTRATOR_QUALIFICATION_OLDER_IMAGE` — 0 fail, 109 expectations, 69 s). In a restricted runtime behind its gateway it showed:

- After boot, `effective.refusals` was `{ connections: 0, queries: 0 }`: the firewall's own checks were not counted, and the workload's boot made no refused request.
- An allowed HTTPS request and an allowed lookup left it at zero.
- Two foreign SNIs at an allowed address (TLS `access_denied`), one foreign Host in plain HTTP on 443 (the gateway's 403), and three refused queries (UDP, TCP, and one sent straight to `192.0.2.53`, each REFUSED) gave `{ connections: 3, queries: 3 }`, and the file held exactly `{"refusedConnections":3,"refusedQueries":3}`.
- The refused label was in none of the gateway's `/run`, `/etc`, `/tmp`, `/var/log` or `/root`, nor in its Docker log.
- Killing the daemon's worker: the supervisor started a new one, the counts stayed at 3 and 3, and one more refused query made them 3 and 4.
- Restarting the runtime and its gateway (a new boot) gave `{ connections: 0, queries: 0 }`.

Each run's `afterAll` removed its owner-labelled runtimes, gateways, fixtures and networks and found none left; afterwards the host had no containers and no network created that day. The image tag was removed after the runs.

## Related

- [7420](7420-telemetry-hosts-grok-and-cursor-turns.md), [6101](6101-egress-name-checks-platform-coverage.md)
- [Container lifecycle, name checks](../../architecture/container-lifecycle.md#name-checks-egress-filter1)
- [7510](7510-refusal-counts-refresh.md): refresh the counts while the Network section is open
