# Name checks hold a newline-less first write on a named port

Found on 2026-11-06 while qualifying the egress gateway's name checks on rootful
Linux Engine ([6101](6101-egress-name-checks-platform-coverage.md) task 1).

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`.

### Tasks

1. **Say what a client-first protocol on a named port must send**: the gateway holds a printable first write that has no newline, and refuses it after 30 s. Status: open.
2. **Decide whether to shorten the hold for writes that cannot become HTTP**: a first write that is not an HTTP method token could be relayed sooner. Status: open (depends on 1).

### 1. Say what a client-first protocol on a named port must send

**Problem.** On an `egress-filter=1` gateway, a TCP connection to an allowed address on an explicitly named non-443 port whose first write is printable text with no newline (for example `probe`) is neither relayed nor refused at once. The daemon waits for a newline, and after `CLASSIFY_TIMEOUT` (30 s) refuses the connection with no reply. A client that sends such a word and waits for an answer sees a hang, then a reset. Two live tests did exactly this and failed on every `egress-filter=1` image; this repository fixed them by sending whole lines.

**Context.** `classify` in `docker/orkestrator-egress-filter.pl` returns `need` for a buffer matching `^[\x09\x0b\x0c\x0d\x20-\x7e]+$` with no newline, so that a request line sent a byte at a time (`G`, `GE`, `GET` …) cannot slip past the Host check by being classified early. `expire_connections` then calls `decide($c, 1)`, which refuses a still-`need` connection as `other`. Binary first bytes (PostgreSQL's startup length, MongoDB, TLS) and server-first protocols (SSH, SMTP, MySQL banners) are not affected, and nor is any line protocol that ends its first command with `\n` (SMTP, POP3, IMAP, Redis inline or RESP, memcached). Neither the allowlist help text (`packages/protocol/src/network-allowlist.ts`) nor `docker/AGENTS.md` mentions this.

**Investigation.** Reproduced live on 2026-11-06 on a disposable rootful Linux Engine 29.9.3 and in CI run 42128741746 (x64): `container-live-firewall.test.ts`'s tuple case failed at its first TCP echo (`:555`, expected 0, received 1) and `container-live-egress-conditions.test.ts`'s DNS-rotation case failed at its first probe. Both pass once each first write ends in `\n`. The same cases had passed on images without `egress-filter`. No product report of a real protocol hitting this is known.

**Decisions.**

- **Where to say it?**
  - **In the gateway's header comment, `docker/AGENTS.md`'s name-check rules and the allowlist help's limits paragraph (recommended).**
    - Pros: the people who add a port entry and the people who change the daemon both see it; no behaviour change.
    - Cons: the help text is already long.
  - **Only in `docker/AGENTS.md`.**
    - Pros: smallest change.
    - Cons: a user with a custom protocol has no way to learn why a named port hangs.

### 2. Decide whether to shorten the hold for writes that cannot become HTTP

**Problem.** The 30 s hold protects the Host check from byte-at-a-time request lines, but it also covers text that can never become an HTTP request line.

**Context.** An HTTP request line starts with a method token (`[!#$%&'*+.^_`|~0-9A-Za-z-]+`) followed by whitespace. A printable buffer containing a character outside that set before any whitespace, for example `{"op":1}`, cannot become one.

**Investigation.** Not prototyped. `tests/unit/egress-filter-daemon.test.ts` already drives `classify` with split requests and would carry the new cases.

**Decisions.**

- **Change the classification?**
  - **Keep the hold, and document it (task 1) (recommended until a real protocol needs more).**
    - Pros: no change to a security boundary; the only observed casualties were tests.
    - Cons: a custom newline-less text protocol on a named port keeps failing after 30 s.
  - **Classify a printable buffer as `other` as soon as it contains a character that no method token may hold before its first whitespace.**
    - Pros: JSON-first and similar protocols pass at once; method-token prefixes stay held.
    - Cons: a new rule in the security-relevant classifier, needing its own split-write tests; bare words like `probe` are still held, since they are valid method tokens.

## Related

- [6101](6101-egress-name-checks-platform-coverage.md): the run that found it
- [6102](6102-egress-name-check-residual-channels.md): what the name checks cannot see
- [6103](6103-live-suite-failures-seen-during-s0100.md): the DNS-rotation case this also broke
