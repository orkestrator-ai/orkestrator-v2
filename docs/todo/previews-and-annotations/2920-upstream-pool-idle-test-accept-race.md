# PreviewUpstreamPool idle-expiry test ends the wrong peer on macOS

## Task analysis

Analysed 2026-11-02 against `main` at `d7cdfaa8b`.

### Tasks

1. **Pair each client with its own accepted peer**: make the test end the server-side socket that belongs to the pooled client. Status: open.
2. **Check the other `accepted.at(-1)` uses**: the "chatty" case in the same test uses the same lookup. Status: open (depends on 1).

### 1. Pair each client with its own accepted peer

**Problem.** `PreviewUpstreamPool > idle connections expire, and one the application closes is never handed out` (`apps/backend/src/preview-upstream-pool.test.ts`) fails every time on arktech-mini (macOS, Bun 1.4.4). `closed(client)` at line 199 times out with `client.destroyed` still `false` (line 85). The default suite (`mise run test`) is red on `main` because of it.

**Context.** The test's `socket()` helper resolves when the client's `connect` event fires, then the test calls `accepted.at(-1)!.end()` to make the "application" close the connection the pool is holding. `accepted` is filled by the server's connection callback.

**Investigation.** On a detached `origin/main` at `d7cdfaa8b` the owner failed three runs out of three, with the other six cases passing:

```sh
bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-upstream-pool.test.ts --parallel=1
```

It still fails on the newer `main` at `fd679c0e2`: two runs of two through `mise run test:logged -- --name ek-pool-N -- bun test --cwd=apps/backend ./src/preview-upstream-pool.test.ts`, each six passing and this one failing.

A standalone `node:net` script under the same Bun (connect, await the client's `connect`, then count the server's accepted sockets) found the server callback had not yet run in 15 of 20 connections. So when `long.put` runs, `accepted.at(-1)` is usually the peer of the earlier `expiring` client, which is already closed. Ending it never reaches `client`, and the pool correctly keeps `client` idle until the 60 s limit. The pool itself (`preview-upstream-pool.ts`, the `end`/`close`/`data` listeners in `put`) is not implicated. Found while validating the environment-terminology branch, which does not touch this code.

**Decisions.**

- **How should the test find the right peer?**
  - **Wait for the server side inside `socket()` (recommended).** Resolve only once both the client's `connect` and the matching server connection have happened (for example, await the next `connection` event alongside `connect`) and return the pair.
    - Pros: every caller gets a deterministic peer; no timing assumptions.
    - Cons: touches the helper used by every case in the file.
  - **Match peers by port.** Find the accepted socket whose `remotePort` equals the client's `localPort`, after waiting for it to appear.
    - Pros: local to the two call sites.
    - Cons: still needs a wait loop for the accept to land.
  - **Add a sleep before `end()`.**
    - Pros: smallest diff.
    - Cons: a timing guess that can fail again under load; the testing guide forbids it.

### 2. Check the other `accepted.at(-1)` uses

**Problem.** The "chatty" case writes to `accepted.at(-1)` the same way, so it can also write to the wrong peer.

**Context.** It passes today only because it runs after the earlier failure or because a later accept has landed by then.

**Investigation.** Not run separately. Once task 1 changes the helper, this case needs the same pairing.

**Decisions.**

- **Fix together or separately?**
  - **Fix in the same change as task 1 (recommended).**
    - Pros: one helper change covers both.
    - Cons: none.
  - **Leave it.**
    - Pros: none.
    - Cons: a latent wrong-peer write.

## Related

- [1202-efficiency-review-follow-ups.md](../cross-cutting/1202-efficiency-review-follow-ups.md) (GW-8 introduced the upstream pool).
