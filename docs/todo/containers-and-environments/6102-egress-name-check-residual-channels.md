# What the gateway's name checks still let through

Carried from the security report's S-0100 file (finding M12) when it was closed on 2026-11-05. The egress gateway now checks TLS SNI, HTTP Host and DNS names against the allowlist; these are the channels and rough edges it leaves, recorded so they are decided rather than forgotten.

## Task analysis

Analysed 2026-11-05 against `main` at `704809a20`.

### Tasks

1. **Names hidden inside TLS**: an encrypted ClientHello and domain fronting. Status: open.
2. **Requests after the first on a connection**: kept-alive HTTP/1.1 and HTTP/2 connection reuse. Status: open.
3. **UDP entries and other protocols**: QUIC and named-port protocols that are not TLS or HTTP. Status: open.
4. **Show the user what was refused**: the gateway counts nothing today. Status: open.
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

**Investigation.** Not built.

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

## Related

- [7420](7420-telemetry-hosts-grok-and-cursor-turns.md), [6101](6101-egress-name-checks-platform-coverage.md)
- [Container lifecycle, name checks](../../architecture/container-lifecycle.md#name-checks-egress-filter1)
