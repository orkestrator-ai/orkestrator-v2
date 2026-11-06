# Every webRequest listener in main answers, even when it throws

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`. Found while fixing flake
0622 for to-do 0042 task 11.

### Tasks

1. **Audit main's other webRequest listeners**: find any path in a listener
   that can throw before it calls Electron's `callback`. Status: open.
2. **Keep it from coming back**: one shared way to install a listener that
   always answers, or a test per listener that a throwing decision still
   answers. Status: open (depends on 1).

### 1. Audit main's other webRequest listeners

**Problem.** A webRequest listener that throws never calls its `callback`. The
request is left unanswered and main takes an uncaught exception. On
2026-10-21 that meant Electron's default blocking error box, which stopped main
before a closed window released its preview attachments (flake
[0622](../../tests/flaky-tests/previews-annotations-and-gateway/0622-service-preview-window-close-remote-release.md)).
Today it opens a sheet, and headless Electron then exited with SIGTRAP
([6303](6303-window-close-during-request-throws.md) task 2). A session
outlives its window, so a listener can run after anything it looks up for that
window is gone.

**Context.** `installRemoteGatewayRequestAuth`
(`apps/desktop/electron/remote-gateway-request-auth.ts`) now catches a throwing
decision and still calls back (commit `03cbf0191`, to-do 0042 D22).
`renderer-file-policy.ts:20` already does the same. The other listeners in
`apps/desktop/electron` are:

- `artifact-host-session.ts:483` (`onBeforeRequest`, calls
  `decideRequest(details)` before `callback`), `:486` (`onBeforeRedirect`, no
  callback) and `:928` (the fail-closed listener installed on disposal);
- `preview-transport-manager.ts:1010` (`onBeforeSendHeaders`) and `:1026`
  (`onBeforeRequest`, whose name lookup answers asynchronously).

**Investigation.** Not audited. At a glance the two preview listeners wrap
their URL parsing in `try`, and the asynchronous lookup in `reachesLocalNetwork`
resolves rather than rejects. Whether `decideRequest` or `observeRedirect` can
throw (for example on a disposed frame, whose `WebFrameMain` getters throw) was
not checked.

**Decisions.**

- **How to audit?**
  - **Read each listener, then add a unit test that a throwing decision still
    answers (recommended).**
    - Pros: a handful of listeners; the tests stay as the guard for task 2.
    - Cons: each listener needs its own harness.
  - **Wrap every listener in a catch-all now, without reading them.**
    - Pros: fast.
    - Cons: chooses an answer (cancel or admit) per listener without knowing
      what fails closed for it; the artifact session must cancel, the preview
      hooks must strip the ingress credential.

### 2. Keep it from coming back

**Problem.** Nothing stops a new listener from throwing before its callback.

**Context.** Electron keeps one listener per event per session, so each owner
installs its own.

**Investigation.** None beyond task 1's list.

**Decisions.**

- **Shared helper or per-listener tests?**
  - **A small `answering(listener, failClosed)` helper used by every listener
    (recommended).**
    - Pros: one place states the rule; a lint search for raw `webRequest.on`
      calls can then find new ones.
    - Cons: touches every listener file.
  - **Only per-listener tests.**
    - Pros: no new abstraction.
    - Cons: a new listener without a test is not caught.

## Related

- [6303](6303-window-close-during-request-throws.md),
  [to-do 0042](../previews-and-annotations/0042-service-preview-rollout.md)
  (task 11, D22)
- [`renderer-security.md`](../../architecture/renderer-security.md)
