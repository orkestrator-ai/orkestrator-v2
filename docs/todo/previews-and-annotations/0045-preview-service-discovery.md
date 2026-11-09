# Preview service discovery

Checked against `main` at `2459b05c` (2026-10-15). Code items done on branch
`todo-0045-preview-service-discovery-810be430b445` (2026-10-25, based on
`20f6de91`). The in-app qualification is now an Electron spec
(`e2e/agent-testing/service-preview-seeded-electron.spec.ts`, 2026-11-03). What
is left is the open question in task 2.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`. Re-checked 2026-11-03
against `main` at `7b48c23f`: everything task 1 exercises is unchanged, and no
spec or dev-test fixture set an `entryPort` yet. Task 1 was acted on that day.

### Tasks

1. **In-app desktop qualification**: the five-step run in a desktop profile
   with two local environments and real dev servers. Status: done (2026-11-03):
   all five checks pass on macOS in
   `e2e/agent-testing/service-preview-seeded-electron.spec.ts`; the restart
   check found a timing gap, fixed in
   3230. See **Assumptions and
   decisions**, D10–D14.
2. **`orkestrator environment exec` as a managed root**: the open question,
   whether detached exec workers should count as ownership roots. Status: open.
3. **Fast-restart recheck on Linux through `ss`**: the seeded preview spec's
   checks 3 and 6 pass on a Linux host without `lsof`. Moved from to-do 3230
   (deleted 2026-11-06). Status: open.

Code items 1 to 5 and the host-level qualification are done and on `main`
(`22b16597`, #1258).

### 1. In-app desktop qualification

**Problem.** Local seeding is on by default and every layer is unit- and
host-tested, but nobody has watched it work through the desktop UI: the wait
state, two environments on one port, the move offer, restart reconnection,
agent-link gesture and framework hints.

**Context.** The file lists the five checks. It suggests batching with
[0031](../cross-cutting/0031-live-provider-and-platform-qualification.md).
The fixture needs an `entryPort` in its repository config.

**Investigation.** The code the run exercises is all present:
`desiredGeneratedDefinitions` with `kind: "entry-port"`
(`apps/backend/src/core/preview-service-registry.ts:192`, `:203`),
`scheduleRecheck` (`:1189`), `LoopbackListenerOwnership`
(`apps/backend/src/core/preview-listener-ownership.ts:127`, `ss` parsing at
`:86`), the roots wired at `apps/backend/src/core/index.ts:388-389`
(`apps/backend/src/core/terminal-runtime.ts:138`,
`apps/backend/src/core/local-server-runtime.ts:153`), `requiresListenerOwner`
(`packages/protocol/src/preview-services.ts:180`), `confirmPreviewService`
(`apps/web/src/lib/backend/previews.ts:104`), `relocationCandidates`
(`apps/web/src/lib/preview-service-display.ts:144`), `PreviewLinkSourceContext`
consumed in `apps/web/src/components/chat/MessageMarkdown.tsx:173`, and
`PreviewFrameworkHints.tsx`. Nothing has changed in the ownership module since
the merge. The Electron suite already drives local fixture environments and
service tabs in a real window
(`e2e/agent-testing/service-preview-electron.spec.ts`, run by
`mise run test:agent:electron`), but none of its tests covers a seeded
`entry:<port>` service; no dev-test fixture sets `entryPort` today.

**Decisions.**

- **Manual run or automated Electron test?**
  - **Add the five checks to `service-preview-electron.spec.ts`
    (recommended).**
    - Pros: the spec already creates local environments and service tabs in a
      real window; the run becomes repeatable regression coverage instead of
      a one-off; runs on Linux too.
    - Cons: the PTY-typed dev server and ⌘⇧-click on an agent reply need a
      scripted terminal and a seeded agent message; more test code to keep.
  - **Manual run in a `dev:test` profile, recorded here.**
    - Pros: matches the file's plan; also checks real look and feel.
    - Cons: one-off evidence that ages; needs someone at the desktop.
- **What counts as a pass for step 3 (restart reconnects)?**
  - **The open tab shows the new process without a manual reload, and the old
    generation is refused (recommended).**
    - Pros: matches the generation-bump design (D3) and the host test.
    - Cons: needs a page marker that differs between the two processes.
  - **The tab loads after one Retry.**
    - Pros: easier to observe.
    - Cons: would accept a regression of the recheck backoff (D6).
- **Batch with 0031 or run alone?**
  - **Run alone, now (recommended).**
    - Pros: needs no special hardware (Linux desktop is enough); unblocks
      closing this file.
    - Cons: one more profile start.
  - **Batch with 0031.**
    - Pros: one session for many runs.
    - Cons: 0031 waits on macOS, Safari and two-machine runs, which would hold
      this file open for no reason.

### 2. `orkestrator environment exec` as a managed root

**Problem.** A dev server started through `orkestrator environment exec` is
`unattributed`, so a seeded service waits until the user clicks **Show any
process**.

**Context.** Open question. Exec runs are detached workers keyed by operation,
not environment; counting them needs their live pid and a reuse guard (D2).

**Investigation.** The worker spawns the command with `detached: true` and
persists `childPid`, `pgid` and `startedAt` to its state file
(`apps/backend/src/core/public-api/exec-worker.ts:73-82`); the worker itself is
re-spawned detached from `/` (`:196`). So a pid and a start time are already
recorded, but the backend holds no live handle, which is exactly what made
terminal and bridge roots safe against pid reuse.

**Decisions.**

- **Count exec runs as roots?**
  - **Not now; keep them `unattributed` with the one-click confirm
    (recommended).**
    - Pros: no pid-reuse risk; the confirm path already exists; agents mostly
      start servers in terminals or bridges, which are roots.
    - Cons: CLI-driven setups need one click per seeded service.
  - **Yes, from the persisted `childPid` checked against the `ps` start time.**
    - Pros: zero-click for CLI-driven workflows.
    - Cons: depends on a state file the backend does not own live; a reused
      pid with a matching environment could misattribute; needs a mapping from
      operation to environment.

### 3. Fast-restart recheck on Linux through `ss`

**Problem.** A dev server restarted inside the 5 s verification window is now
rechecked by its listener pids and gets a new generation. Task 1's in-app run
was on macOS, where the lookup uses `lsof`; on a Linux host without `lsof` it
goes through `ss -H -ltnp`, which has not run live.

**Context.** Moved from to-do 3230 (deleted 2026-11-06). The recheck is in
`apps/backend/src/core/preview-service-registry.ts` (`listenerPids`,
`samePids`) and `preview-listener-ownership.ts` (the `ss` path); deterministic
coverage is `preview-verification-window.test.ts`. The window and its gaps are
in [`browser-previews.md`](../../architecture/browser-previews.md).

**Investigation.** Steps:

1. On a Linux desktop host without `lsof`, run
   `e2e/agent-testing/service-preview-seeded-electron.spec.ts` on a throwaway
   profile, so the recheck goes through `ss`.
2. Check that checks 3 and 6 pass, and that the generation changes on a restart
   inside 5 s.
3. Repeat once with `lsof` installed, to cover both lookup paths.
4. Record the result in 0042's evidence log.

**Decisions.**

- **How to get a host without `lsof`?**
  - **A Linux host where `lsof` is not installed (recommended).**
    - Pros: the real fallback, chosen the way production chooses it.
    - Cons: may need a fresh VM.
  - **Hide `lsof` from the profile's `PATH`.**
    - Pros: any Linux host.
    - Cons: a test arrangement, not a real host.

Preview services used to be generated only for containerized environments.
Local worktree and backend-host services had to be registered by hand and were
always labelled `user-registered`. This file added local seeding, ownership for
servers the backend's own terminals and agents start, explicit re-registration
when a dev server moves port, agent links that open preview tabs, and copyable
framework setup hints. None of them treats an open port as proof of ownership.

## Current state

Behaviour is documented in
[browser-previews.md](../../architecture/browser-previews.md) §"Local
environments", §"Diagnostics" and §"Framework configuration".

- **Seeding.** `desiredGeneratedDefinitions`
  (`apps/backend/src/core/preview-service-registry.ts`) now gives a local
  environment its `entryPort` as a `worktree` service (`provenance:
  "entry-port"`, key `entry:<port>`, label `app`, the entry service). Containers
  are unchanged. Nothing is generated from a port scan.
- **Ownership.** `LoopbackListenerOwnership`
  (`apps/backend/src/core/preview-listener-ownership.ts`) looks up the one
  registered port (`lsof -nP -a -i4|6TCP:<port> -sTCP:LISTEN -Fp`, or `ss -H
  -ltnp` on Linux without `lsof`), then walks `ps -A -o pid=,ppid=,lstart=` up
  to a *managed process root*: a local terminal shell
  (`TerminalRuntime.localProcessRoots`) or local agent bridge
  (`LocalServerRuntime.localProcessRoots`), wired in `apps/backend/src/core/index.ts`.
  `PreviewTargetResolver.resolveLoopback` reports `managed-process` for this
  environment's listener, refuses another environment's listener for
  `worktree` targets, refuses everything else for an unconfirmed seeded
  service (`requiresListenerOwner` in `packages/protocol/src/preview-services.ts`),
  and otherwise stays `user-registered`. The managed binding key carries a
  digest of the listener pid and start time, so a restart bumps the endpoint
  generation. The endpoint snapshot gains an optional `listener` field.
- **Waiting and confirming.** A refused seeded service is re-resolved on the
  readiness backoff (`scheduleRecheck` in the registry); **Retry** restarts the
  schedule. **Show any process** sends an empty `update_preview_service` patch
  (`confirmPreviewService` in `apps/web/src/lib/backend/previews.ts`), which
  flips `userOverride` and makes it the user's registration.
- **Port increments.** The link chooser (`PreviewIntentChooser` in
  `ServiceBrowserTab.tsx`) offers **Move `<service>` from port A to B** for
  nearby services of the same kind and scheme (`relocationCandidates` in
  `apps/web/src/lib/preview-service-display.ts`). Nothing moves without the click.
- **Agent links.** `PreviewLinkSourceContext`
  (`apps/web/src/components/chat/link-source-context.ts`) is provided by
  `AgentNativeTab` for environment agent tabs (not coordinators). In
  `MarkdownLink`, ⌘⇧-click (Ctrl+Shift-click) on a loopback link sends a
  `TerminalBrowserTabRequest` with `origin: "agent"`; `TerminalContainer`
  passes it to `linkBrowserTarget(environment, url, "agent")`. A plain click
  still calls `openInBrowser`.
- **Framework hints.** Route details → **Framework setup hints**
  (`PreviewFrameworkHints.tsx`, catalogue in
  `apps/web/src/lib/preview-framework-hints.ts`): Vite 5–7, Auth.js v5,
  NextAuth v4, Next.js 14–16, Express 4–5 and OAuth providers, each labelled
  with its versions and filled with the service's private origin from
  `get_preview_public_origin` when published. Copy only; the project is never
  edited.
- **Diagnostics.** `diagnoseService` explains "Another environment's server is
  on port N" and "Waiting for this environment's server on port N" (with the
  reason: nothing yet, a process this environment did not start, or the host
  cannot check). Route details show an **owner** row; `user-registered` reads
  "any process listening on this port is shown".
- The resolver still refuses Orkestrator's own ports and the in-container agent
  servers on 4096–4102.

## Outstanding work

### Code

1. ~~Local seeding.~~ **Done.** Seeded as a `worktree` service that opens only
   a listener this environment started, until the user confirms it (see
   **Assumptions and decisions**, D1). Evidence:
   `preview-local-discovery.test.ts` ("a local environment's entry port is
   seeded…", "a seeded service opens only a server this environment
   started", "confirming a seeded service…", "without an ownership check…").
2. ~~Managed-process ownership.~~ **Done.** Terminal shells and agent bridges
   are the roots; the listener's pid and start time are the start marker.
   Without attribution a target stays `user-registered` and route details say
   so. Evidence: `preview-listener-ownership.test.ts` (parsing, attribution,
   `ss` fallback, stale-listing refetch, restart key, and a real `lsof`/`ps`
   run on this Mac), `preview-managed-roots.test.ts`.
3. ~~Port increments.~~ **Done.** Re-registration is offered from the link and
   applied only on the user's click. Evidence:
   `ServiceBrowserTab.test.tsx` ("a dev server on the next free port is offered
   as a move…"), `preview-local-discovery-display.test.ts`
   (`relocationCandidates`), `preview-local-discovery.test.ts` ("an
   auto-incremented port is offered for re-registration, never guessed").
4. ~~Agent links.~~ **Done.** Opt-in gesture; the default click is unchanged.
   Evidence: `MessageMarkdown.preview-links.test.tsx`,
   `TerminalContainer.helpers.test.tsx` ("opens an agent's loopback link as an
   agent-link intent…").
5. ~~Framework setup hints.~~ **Done.** Evidence:
   `preview-local-discovery-display.test.ts` ("framework setup hints"),
   `PreviewDiagnostics.test.tsx` ("route details name the owner and open
   copyable framework hints").

### Qualification

- ~~Host-level qualification~~ **Done on macOS 27 (Darwin 27.0.0), Bun 1.4.4,
  2026-10-25.** `preview-local-discovery.test.ts` §"on this host" runs the real
  registry, resolver, `lsof`, `ps` and process tree: two local environments on
  one entry port (each opens only its own server; the second dev server moves
  to the next port and is moved there by explicit update), a restart on the
  reused port (same service, new generation, the old generation is refused),
  and a dev server typed into a real local terminal PTY (`spawnPty` registered
  in `TerminalRuntime`) attributed to its environment and refused to the other.
  Linux: `preview-listener-ownership.test.ts` §"on this host" passed in the
  `orkestrator-v2` image (Debian 13 trixie, aarch64, Bun 1.4.4, no `lsof`),
  attributing a real listener through the `ss` fallback (this environment,
  another environment, unattributed, none). The two-environment PTY test is
  macOS-only.
- ~~In-app qualification~~ **Done on macOS 27 (Darwin 27.0.0), Bun 1.4.4,
  2026-11-03,** as `e2e/agent-testing/service-preview-seeded-electron.spec.ts`
  in `mise run test:agent:electron`. The spec launches the real Electron app
  on a disposable agent-test profile under a temporary root, gives the
  dev-test fixture project (`test-fixtures/agent-project`) an `entryPort` and a
  `run` command, and creates two local environments from it. Each of the five
  checks below passes; how each was observed, and what each does not cover, is
  in D10–D14. The original plan was:
  1. the environment browser button opens the seeded `app` service, which
     shows "Waiting for this environment's server" until **Run** starts the
     dev server, then loads it without a retry (recheck backoff);
  2. with both environments' servers running, each opens only its own; the
     second's terminal link (⌘⇧-click) offers **Move app from port A to B**
     and then loads its own server;
  3. restarting a dev server reconnects the open tab to the new process;
  4. ⌘⇧-click on a `localhost` link in an agent's reply opens a preview tab in
     that environment, and a plain click opens the system browser;
  5. route details → **Framework setup hints** shows the private origin when
     publication is on, and **Copy** puts the snippet on the clipboard.

  Results (two consecutive passing runs of the spec, about 25 s each on a
  loaded host):
  1. The browser button opens the seeded `app` service (`worktree`, entry
     port), which shows "Waiting for this environment's server on port N" and
     attaches nothing. After **Run**, the registry's own recheck resolves it to
     `managed-process` with no Retry, and the tab shows this environment's
     server.
  2. With environment A's server on the entry port, B's seeded service shows
     "Another environment's server is on port N" (listener
     `other-environment`) and attaches nothing. B's server moves to N+1; the
     ⌘⇧-click on the address it prints opens the link chooser with **Move app
     from port N to N+1**, which moves B's service and loads B's server. A
     still shows its own server on N.
  3. After Ctrl-C and the same command in A's terminal, the fixture client
     polls and renders the new process in its visible heading. The document
     identity stays unchanged. The endpoint generation advances, and an
     attachment issued at the old generation is specifically refused on renewal.
     Until 3230 this held only
     once the registry's 5 s verification window had passed; the check now
     restarts with no wait. See D12.
  4. A plain click on a `localhost` link in an agent reply opens the system
     browser (captured in the main process, never launched); ⌘⇧-click opens a
     preview tab in that environment bound to its seeded service, showing its
     server.
  5. With publication on (throwaway CA and certificate for `preview.test`,
     loopback listener on an ephemeral port), route details → **Framework
     setup hints** shows `Public origin https://s-<id>.preview.test:<port>`,
     and **Copy** on the Next.js hint puts `PUBLIC_ORIGIN=<origin>` on the
     clipboard. The user's clipboard text is restored afterwards.

  Not covered: Linux and Windows desktops (the spec is not platform-gated, but
  was only run on macOS); a billed provider transcript (the actual
  AgentNativeTab is covered with synthetic projection data, D13); the real
  system browser opening (deliberately captured).

## Constraints and rationale

- No broad port scans: only the port a definition names is looked up, and
  terminal output is never logged as discovery telemetry.
- Terminal and agent text is a hint, never authority to publish or associate a
  service. A link only proposes registration or a move.
- Never associate an arbitrary host listener with an environment implicitly.
  Manual targets stay backend-loopback only.
- Keep refusing reserved Orkestrator, agent-bridge, agent-tool and Docker API
  ports.
- A TCP handshake does not prove process identity. `managed-process` means
  "started under this backend's terminal or agent for that environment", not
  cryptographic proof.

## Assumptions and decisions

**D1. Local seeding: seed now, but only show a provably owned server.**
Options: (a) seed as `user-registered`, with diagnostics saying any process on
the port is shown; (b) wait for managed-process ownership and seed only from
it; (c) seed always, and resolve the seeded service only to a listener this
environment started until the user confirms it. **Chosen: (c).** It removes
the setup step for the common case (dev server run in an Orkestrator terminal
or by an agent) while honouring "never open another environment's server": two
local environments share every port, so (a) would open whichever server holds
it. Pros: zero setup when the server runs under Orkestrator; a clear wait state
otherwise; one click to opt into (a)'s behaviour. Cons: a server started in an
outside terminal app needs that click; a seeded service now occupies the entry
port, so registering the same `worktree` port again reports a conflict (edit
the seeded one instead). Open question 1 ("is seeding wanted?") is answered
yes, in this guarded form.

**D2. Ownership roots: the backend's own terminal shells and agent bridges.**
Options: (a) build a backend-owned dev-server launcher first; (b) treat
processes descending from backend-started local terminals and agent bridges as
managed; (c) attribute by working directory inside the worktree. **Chosen:
(b).** No dev-server launcher exists (Run Commands launch a terminal job), so
open question 2 is answered: item 2 hooks into the terminal PTYs and local
bridges the backend already holds. Pros: covers terminals, Run Commands and
agent-started servers with no new launcher; the backend holds a live handle to
each root, so a root pid cannot be stale. Cons: needs `lsof` (or `ss` on Linux)
and `ps`; servers started through `orkestrator environment exec` run under
detached workers that outlive the backend and are not roots (`unattributed`);
a listener owned by another OS user is invisible (`none` or `unattributed`).
(c) was rejected: a cwd is a convention, not a fact about who started it.

**D3. Start marker: listener pid plus `ps` start time, digested into the
binding key.** Options: record the pid only; pid and start time; a durable
record. **Chosen:** pid and start time, in memory per backend epoch. Pros: a
restart or pid reuse changes the key and revokes old attachments; nothing
durable to go stale. Cons: an attribution was reused for the existing 5-second
verification window, as container bindings are; since
3230 a new connection inside the
window also compares the listener's pids.

**D4. Linux without `lsof`: fall back to `ss`.** The Debian image used for
containers lacks `lsof`, as do minimal Linux installs; `ss` (iproute2) is
nearly universal. A listener shown without a pid (another user) is
`unattributed`, never `none`. If neither tool runs the answer is `unchecked`
and seeded services wait for confirmation.

**D5. Confirmation is an empty update.** Options: a new `confirmed` field
(schema change), a new command, or reuse `userOverride` (already "the user
edited a generated definition"). **Chosen:** an empty `update_preview_service`
patch. Pros: no schema or command change; older clients can confirm by editing.
Cons: any edit, even a label, also confirms; documented in the UI copy and
`requiresListenerOwner`.

**D6. Waiting services recheck on the readiness backoff.** Options: client
polling, a registry timer, or Retry only. **Chosen:** registry timer on the
existing 1–30 s schedule, bounded, restarted by Retry or a lifecycle change.
Pros: works with no mounted client and opens as soon as the server starts.
Cons: up to six extra `lsof`/`ps` pairs per waiting service per minute.

**D7. Port increments: offer a move, never apply one.** Options: auto-move on
a matching link, a terminal-output watcher, or a choice in the link chooser.
**Chosen:** the chooser lists up to three nearby services of the same kind and
scheme. Pros: explicit, no output parsing. Cons: the user must open the new
address once.

**D8. Agent links: ⌘⇧-click, same as the terminal.** Options: change the
default click, add an icon beside every loopback link, or the terminal's
gesture. **Chosen:** the gesture, with a tooltip on loopback links in an
environment's agent tab. Pros: default unchanged, consistent with terminals.
Cons: less discoverable than a button. Coordinator and mail transcripts have
no environment and keep the plain behaviour.

**D9. Framework hints: a static, version-labelled catalogue in route details.**
Options: detect the framework from `package.json`, or a static catalogue.
**Chosen:** static, filled with the service's origin. Pros: never reads or
edits the project; works for containers and local alike. Cons: the user picks
the relevant entry; the catalogue must follow the forwarding rules in
`browser-previews.md` §"Framework configuration".

**D10. Task 1, where the checks live: a sibling Electron spec, not inside
`service-preview-electron.spec.ts`.** Options: (a) add the five checks to
`service-preview-electron.spec.ts` as the task recommended; (b) a sibling spec
in the same Electron suite, sharing the launch code. **Chosen: (b),**
`service-preview-seeded-electron.spec.ts`, listed in
`playwright.electron.config.ts`. The existing spec was already 3,255 lines,
over the repository's 2,000-line limit, and its stack (one environment, two
user-registered services, a second backend) shares nothing with this one but
the Electron launch. That launch moved to `service-preview-electron-launch.ts`,
which both specs import, so the old spec shrank to 3,088 lines. Pros: runs in
`mise run test:agent:electron` exactly as (a) would; independent setup; no
growth of an oversized file. Cons: a second Electron start per suite run
(about 20 s).

**D11. Task 1, the fixture: entry port in the repository config, `run` in a
committed `orkestrator-ai.json`, and a Vite-like dev server.** Options for the
port: (a) set `entryPort` in `seedFixture` for every `dev:test` profile; (b)
set it in the spec through `patch_repository_settings`. **Chosen: (b)**, on a
reserved port pair (N and N+1 free): (a) would give every `dev:test` profile a
seeded service on a fixed port that other agents' profiles on the same host
share. For the server, the spec's `run` command starts
`e2e/agent-testing/seeded-entry-dev-server.ts` with the bun on the test's
PATH. Like Vite it moves to the next port when its own is taken, and its page
marker names the worktree and the process id. The agent-project's own
`server.ts` binds a fixed port and has a constant marker, so it could not show
the port move or tell two processes apart; it is unchanged.

**D12. Task 1, the restart pass criterion.** Options: (a) inject a health
request and check transport reachability (simple, but cannot prove the visible
update); (b) give the fixture an application-owned polling client and check its
rendered marker alongside a document identity sentinel (recommended).
**Chosen: (b).** The client renders the new process marker in its heading and
body dataset. The test requires the new marker, unchanged document identity,
unchanged tab URL, a newer generation and specifically `access-expired` or
`generation-changed` on old-attachment renewal. Unrelated errors fail.
Check 6 separately restarts within five seconds and requires a newer
generation, the guard for 3230,
which also removed the restart wait from check 3.
The fixture closes each health response so polling opens new connections
and exercises tunnel revalidation rather than indefinitely reusing a socket.

**D13. Task 1, the agent reply is the real `MessageMarkdown`, not a live agent
turn.** Options: (a) drive a real agent to print the link; (b) render the real
`MessageMarkdown` inside the `PreviewLinkSourceContext` that `AgentNativeTab`
provides, sourced from a tab of that environment. **Chosen: (b).** (a) needs a
billed provider turn and credentials in the test profile. (b) runs the real
`MarkdownLink` handler, `requestTerminalBrowserTab`, `TerminalContainer`'s
listener, `linkBrowserTarget(…, "agent")` and the link chooser's resolution;
the Electron check skips the provider of the context. A companion
`AgentNativeTab.test.tsx` test now renders an actual agent transcript from a
synthetic authoritative projection, clicks its real Markdown link and requires
the actual environment and agent tab identity in the preview request event.
This covers the provider without a billed turn. `shell.openExternal` is
captured in the main process for the plain click, so no browser opens on the
host.

**D14. Task 1, the restart is typed into the same terminal through its
backend session.** Ctrl-C and the command are written with
`local_terminal_write` to the Run Commands tab's PTY, rather than typed with the
keyboard, so the service tab stays visible throughout. The PTY, the shell and
therefore the ownership root are the ones **Run** created.

## Open questions

- Should `orkestrator environment exec` runs count as managed roots? They are
  detached workers keyed by operation, not environment, so it needs their
  live pid from the exec state and a guard against pid reuse.

## Related

- `3230-restart-inside-verification-window.md` (deleted 2026-11-06)
  (a restart inside the 5 s verification window kept the old generation; fixed).
- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) (transports,
  qualification and legacy route).
- [browser-previews.md](../../architecture/browser-previews.md) §"Local
  environments" and §"Framework configuration".

## Replaces

- `docs/improvements/browser/plan/04-target-resolution-and-readiness.md`
  (worktree and managed-process ownership)
- `docs/improvements/browser/plan/09-client-resolution-and-migration.md`
  (agent-provided links)
- `docs/improvements/browser/plan/12-service-controls-and-diagnostics.md`
  (framework setup hints, later discovery)
- `docs/improvements/browser/proposal.md` §1 and §6 (later discovery,
  multiple services)


## Assumptions and decisions

### Task 1: review coverage repairs

Chose a polling fixture client with a document sentinel over transport-only
assertions because the acceptance criterion requires a visible update. Kept
production ownership behavior unchanged and added a narrowly annotated
expected-failure fast-restart check for 3230 (annotation removed when 3230 was
fixed). Chose an actual AgentNativeTab
component with synthetic projection data to cover its context provider without
credentials or billing; the Electron check still owns the end-to-end chooser.
