# Pi commands before the first turn

Checked against `main` at `8454d18b` (2026-10-24). Implemented on branch
`todo-0069-pi-commands-first-turn-694a28fc5c19` on 2026-10-25, against `main`
at `20f6de91`, Pi SDK 1.4.0.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

The file is Finished: every item is done and merged to `main` in `7170f454`
(#1254, 2026-10-25). The only open decision is what to do with the file.

### Tasks

1. **Resource-only Pi command read before attach**: list templates and skills as `stale` + `attachPending` (or `ready`) without attaching. Status: done.
2. **Live picker qualification, host and container**: `slash-command-picker.spec.ts` Pi step with no refresh. Status: done.
3. **Retire the finished file**: delete it under the folder rules now that its branch has merged. Status: open.

### 1. Resource-only Pi command read before attach

**Problem.** A new Pi tab's `/` menu showed only `/steer` and `/compact` until the session attached.

**Context.** Found by the 0016 picker run; parity with Claude, Codex, OpenCode and Grok, which list before the first turn.

**Investigation.** On `main`: `bridges/pi-bridge/src/command-preview.ts` with `COMMAND_PREVIEW_READ_WAIT_MS` at `:54`, the private-field guard `skipPackageInstalls` at `:76-84`, and the Multi Review `discarded` retry at `:165` and `:179`; `attachPending` in `packages/protocol/src/agent-command-catalogue.ts:200` and `:340`; the picker line in `apps/web/src/components/native-agent/useNativeCommandComposer.tsx:62` (tested in `AgentNativeTab.commands.test.tsx:670`). Durable docs are in place: `docs/architecture/native-agent-commands.md:79`, `:213`, `:313` and `:366`, and `bridges/pi-bridge/AGENTS.md:145-149`. The Pi SDK pin is still `1.4.0` (`bridges/pi-bridge/package.json:17`), so the private `packageManager` field the guard reaches is unchanged; only release version bumps touched these files since. The residual risk (decision 3: a Pi bump renaming the field) fails closed and is pinned by `command-preview.test.ts`, and the Pi bridge `AGENTS.md` already tells the next bumper about it.

**Decisions.** None: done and merged.

### 2. Live picker qualification, host and container

**Problem.** The change needed live proof without the attaching refresh step, and the original "Needs verification" asked for a container tab.

**Context.** Profile `qa-picker-0069`, Pi SDK/CLI 1.4.0, 2026-10-25; validation run recorded in `docs/tests/flaky-tests/aggregate-validation-runs/0860-pi-commands-before-first-turn-validation.md`.

**Investigation.** Both runs recorded as passed. Not re-run (research only); no Pi bump since.

**Decisions.** None: done. A re-run belongs to the next Pi pin bump, under `docs/development/upgrade-agents.md`.

### 3. Retire the finished file

**Problem.** The folder rules say a finished file is deleted once its durable behaviour has moved; this one was kept "until the Multi Review of this branch".

**Context.** The branch merged as #1254 on 2026-10-25, and the Multi Review (`action-18dc39945a2fed456047a580352a4781`) is recorded in item 1, so the keep condition has passed. Inbound links: `0016-slash-command-catalogue.md`, the folder index row 5, and two flaky-test case files (`0860-…` and `0239-…`).

**Investigation.** Everything durable is already in `native-agent-commands.md` and the Pi bridge `AGENTS.md`. The decision rationale (why a resource-only read rather than an early attach; why the private-field guard) lives only here and in the #1254 description.

**Decisions.**

- **What to do with the file now?**
  - **Delete it now, after moving the one-paragraph rationale for decisions 1 and 3 into `native-agent-commands.md` (recommended).** Remove the file and its index row; turn the links in 0016 and the two flaky cases into plain text naming #1254.
    - Pros: follows the folder rules; the keep condition is met; the next Pi bumper keeps the reason the guard exists next to the contract.
    - Cons: a small edit to an architecture doc and to three referring files.
  - **Delete it now without moving anything.**
    - Pros: smallest change; `AGENTS.md:145-149` already states the guard and its test.
    - Cons: the reasons an early attach was rejected (extension code, MCP client and auth check per unused tab) survive only in git history.
  - **Keep it until the next Pi pin bump re-proves the private-field guard.**
    - Pros: the evidence stays at hand for that bump.
    - Cons: contradicts the folder rules; the guard already fails closed in tests, so there is nothing for the file to track.

A new Pi tab's `/` menu listed none of Pi's own commands (templates, skills,
extension commands) until its session attached, which happens at the first
turn or when the user presses "Refresh commands" in the menu. Until then it
showed only Orkestrator's `/steer` and `/compact` with "This list may be out
of date".
Every other provider lists its commands before the first turn: Claude from a
control-only probe, Codex from `skills/list`, OpenCode from `command.list`,
and Grok from its push after `session/new`. Found by the live picker run in
[0016](0016-slash-command-catalogue.md) on 2026-10-24.

## Current state

- **Fixed.** A Pi session that has not attached now lists its templates and
  skills from a resource-only read (`bridges/pi-bridge/src/command-preview.ts`):
  Pi's own `DefaultResourceLoader` with extensions, themes and context files
  off, the session's own discovery switches and project trust, and package
  resolution told to skip a missing package instead of installing it. The rows
  go through the same `buildCommandCatalogue` an attach uses, so ids and
  binding revisions match what the attach publishes.
- `POST /session/create` starts the read; `GET /session/:id/commands` starts
  it if it is due and waits for it up to 5 s
  (`COMMAND_PREVIEW_READ_WAIT_MS`), then answers. The read never attaches,
  never touches `lastAccessed` and never hydrates a transcript, so the
  metadata contract holds. A later finish moves `commandRevision`, which the
  backend already revalidates on.
- When the session's policy lets extensions load (`projectResources: true`
  on a host worktree, containers by default), the list is `stale` with the
  new catalogue field `attachPending: true`: extension commands, and
  resources an extension contributes through `resources_discover`, only exist
  after attach. When the policy excludes extensions (host default, read-only
  sessions) nothing can add a command at attach, so the read is `ready`.
- `attachPending` is carried by the protocol normalizer
  (`agent-command-catalogue.ts`, enhanced `stale` lists only), the HTTP
  catalogue adapter, the backend cache (kept on rows retained through a
  failed re-read, dropped from any list that is not `stale`) and
  `NativeAgentCommandCatalogueState`. The picker adds "More commands load when
  the session starts; refresh to load them now." to the stale line
  (`useNativeCommandComposer.tsx`). It is persisted with the rows
  (`commandsAttachPending`), and restored preview rows are read again.
- Rows an attach read (live, kept across an idle detach, or restored) are
  never replaced by a preview, and `publishAttachedSession` clears the
  preview so a late one cannot overwrite an attach. A selection made from a
  preview row is re-resolved after the prompt route attaches, against the
  attached list and Pi's own dispatch order (existing code), so a template an
  extension turns out to shadow is refused with 422, never run as the
  extension.
- The refresh button is unchanged: on a session that has not attached it
  attaches and answers `reloaded`, which loads extension commands too.
- Contract docs: [native-agent-commands.md](../../architecture/native-agent-commands.md)
  (wire contract, Pi provider note, lifecycle, support tables).

## Outstanding work

### Code

1. ~~**List Pi's commands before the first turn without breaking the metadata
   contract.**~~ Done 2026-10-25: a resource-only read of templates and
   skills, published `stale` + `attachPending` (or `ready` when the policy
   loads no extensions), with the picker saying extension commands arrive on
   attach. See decisions 1 to 4.
   Evidence:
   - Real SDK (`command-preview.test.ts`, "resource-only command read (SDK
     pin)"): a project and agent directory with templates, a skill, a project
     and a user extension that record being imported, and a configured npm
     package that is not installed. The read lists `/alpha`, `/mine` and
     `/skill:lint`, imports neither extension and attempts no install; the
     same loader without the guard does attempt the install; the policy
     switches are followed (no project resources or read-only: empty); and
     the template and skill rows equal what the attach path's loader
     (`createPiSessionServices`) lists, which also loaded both extensions.
   - Lifecycle (`command-preview.test.ts`): stale + `attachPending` for a
     never-read session, `ready` when no extension can load, one read per
     policy and another on a policy change, attach-read rows left alone, an
     attach landing first wins, a failed read stays `stale`/empty with a
     notice and no retry loop, a slow read is waited on only for the bound,
     `lastAccessed` untouched.
   - Route (`http.test.ts`): `POST /session/create` then
     `GET /session/:id/commands` answers the template as `stale` +
     `attachPending` without attaching (the attach hook is never called),
     keeps `lastAccessed`, publishes `commandRevision` on `/status`, and
     reads once.
   - Persistence, protocol, backend adapter and cache, and renderer tests
     cover the new field end to end.
   - Multi Review (`action-18dc39945a2fed456047a580352a4781`, verdict "ready
     with fixes") found one P1, fixed: a preview that finished while an
     attach was in flight was discarded but stayed cached, so if that attach
     then failed no later catalogue read retried discovery. A discarded
     preview is now marked `discarded` and the next read under the same
     policy reads again; a read whose policy changed mid-flight, or whose
     session closed, is discarded the same way. Its three test gaps are
     covered: the failed-attach retry (success and failure reads), the
     closed-session and policy-change discard branches, and
     `http-command-preview.test.ts`, which submits a command selected from an
     unattached preview through the first prompt's attach: unchanged it runs
     with its arguments verbatim (202); shadowed by an extension bound at
     attach it is refused with 422 `command-unavailable` before anything is
     journaled.

### Qualification

- ~~Re-run `slash-command-picker.spec.ts` for Pi after the change, without its
  attaching refresh step.~~ Done 2026-10-25, host worktree: profile
  `qa-picker-0069` (`--credential-source pi --agent-platforms pi`), Pi
  SDK/CLI 1.4.0. The spec's Pi step now waits for the two planted
  `.pi/prompts` templates with no refresh and no turn, then checks the
  catalogue is `stale` with `attachPending: true`, the transcript is empty
  and the picker shows the new line; the source-group, keyboard, on-disk
  edit (refresh, which attaches) and hard-reload steps followed. Passed
  (`live slash-command picker in a local environment (pi)`, 6.9 s and
  11.2 s on two runs).
- ~~Container Pi tab.~~ Done 2026-10-25: the same profile restarted with
  `--fixture-environments local,container` (dev image built from this
  worktree, so the container ran this bridge), and
  `ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT=container`. A containerized
  environment with no policy override (containers load project resources by
  default), templates written into `/workspace/.pi/prompts` through
  `docker exec` as `node`. The same Pi step passed (planted templates listed
  before attach, `stale` + `attachPending`, empty transcript, picker line),
  then every later step (`live slash-command picker in a container
  environment (pi)`, 1.5 min including the container start). The profile was
  stopped and reset afterwards.

## Constraints and rationale

- Catalogue reads are metadata: they must not touch `lastAccessed`, hydrate a
  transcript or re-attach an idle session
  ([`native-agent-commands.md`](../../architecture/native-agent-commands.md)).
  The preview does none of these; it reads files.
- Pi's `reload()` and extension binding run extension code; anything that
  attaches early must respect the busy rules in the Pi provider notes. The
  preview attaches nothing and loads no extension, so those rules are not in
  play.
- Package installs run code too (npm lifecycle scripts, git clones), which is
  why the preview skips missing packages rather than letting Pi's loader
  install them.

## Open questions

- ~~Does Pi 1.4.0 expose resource discovery (templates and skills) without a
  bound `AgentSession`?~~ Yes: `DefaultResourceLoader` is exported, and
  `noExtensions: true` with no inline factories and no `resolveProjectTrust`
  callback loads no extension module. Its `reload()` does call
  `DefaultPackageManager.resolve()` without an `onMissing` handler, which
  installs missing packages; the loader keeps the manager in a private field
  with no option to change that (decision 3).

## Needs verification

- ~~Whether a container Pi tab behaves the same (only a host worktree was
  run).~~ See the container entry under Qualification.

## Assumptions and decisions

Made on 2026-10-25 while implementing this file.

1. **How to list Pi's commands before the first turn.**
   - Options: (a) attach when the tab opens (at `POST /session/create` or the
     renderer's `ensureNativeAgentSession`); (b) a resource-only read of
     templates and skills, with extension commands added at attach; (c)
     attach on the first picker open; (d) keep the empty list and only change
     the picker's wording.
   - Chosen: (b), plus (d)'s wording for what (b) cannot list.
   - Why: (a) and (c) run extension code (and an MCP client, and an auth
     check) before the user asked for anything, for every tab, including tabs
     that are never used; (c) also makes opening a menu a side-effecting
     action. (d) leaves the parity gap. Templates and skills are files, Pi's
     loader reads them without running anything, and they are most of what a
     user plants.
   - Pros: the metadata contract holds; nothing runs early; the rows are
     byte-identical to the attach's (one builder), so selections stay valid
     across the attach; no Pi session file is created before the first turn.
     Cons: extension commands still appear only after attach (the picker says
     so); a second resource scan per new tab (one disk read, before attach
     only); one private SDK field is reached (decision 3).
2. **Status of the preview list.**
   - Options: (a) always `stale`; (b) always `ready`; (c) `stale` with a new
     `attachPending` marker when extensions could add commands, `ready` when
     the policy loads none.
   - Chosen: (c).
   - Why: `ready` means authoritative, and a list without extension commands
     is not when extensions can load. When the policy sets `noExtensions`
     (host default, read-only), Pi's loader loads no extension on attach
     either and the bridge's inline extensions register no commands, so the
     read is the whole inventory; calling it stale would show "may be out of
     date" on every default host tab for no reason. A distinct marker lets
     the picker say why the list is partial rather than "may be out of date".
   - Pros: honest status in both cases; the picker can explain itself; the
     field is additive (older backends and bridges ignore or never send it).
     Cons: a protocol field touching protocol, backend and renderer; if a pin
     bump made the bridge's inline extensions register commands, the `ready`
     case would need revisiting (the attach still replaces the list on the
     first turn, and selections are re-checked).
3. **Stopping the loader from installing packages.**
   - Options: (a) let `reload()` install a missing package, as attach would;
     (b) set `PI_OFFLINE` around the read; (c) re-implement Pi's resource
     merging from exported pieces (`DefaultPackageManager`, `loadSkills`, …);
     (d) wrap the loader's private `packageManager.resolve` to pass a `skip`
     handler.
   - Chosen: (d), failing closed: if the field is missing the read throws, no
     preview is published and the list stays as before.
   - Why: (a) runs npm lifecycle scripts or git clones when a tab opens. (b)
     is process-wide and would also stop a concurrent attach in another tab
     from installing. (c) duplicates collision, precedence and source-info
     rules that would drift from the attach path. (d) is one line, scoped to
     the preview's own loader, and pinned by two real-SDK tests (the guarded
     read installs nothing; the unguarded loader does try to install).
   - Pros: no install before attach; same resolution rules as attach. Cons:
     depends on a private field name, so a Pi bump can break it (loudly, in
     tests, and safely, in production).
4. **When the read runs and how long a catalogue read waits.**
   - Options: (a) only at create; (b) only lazily in the catalogue read; (c)
     started at create, awaited (bounded) by the catalogue read, which also
     starts it if it is due.
   - Chosen: (c), waiting up to 5 s.
   - Why: create alone misses restored sessions and policy changes; lazy
     alone makes the first read pay the whole scan. Waiting means a new tab's
     first catalogue read already carries the rows; the bound keeps the read
     well inside the backend's 15 s catalogue timeout, and a slower read
     publishes later through `commandRevision`.
   - Pros: rows on the first read in practice; no polling. Cons: a catalogue
     read can take up to 5 s on a very slow volume (the backend shows
     "Loading commands…" meanwhile).
5. **What a preview may replace.**
   - Options: (a) re-read on every catalogue read; (b) once per resource
     policy, never over a list an attach read; (c) once per session.
   - Chosen: (b). Restored preview rows (persisted with
     `commandsAttachPending`) are read again after a restart.
   - Why: attach-read rows include extension commands, so replacing them
     with a preview would lose rows; (a) rescans the disk every 30 s per open
     tab; (c) misses a policy change made by an idempotent create. A refresh
     (which attaches) remains the way to pick up an on-disk edit, as it is
     after attach.
   - Pros: bounded work; never loses better rows. Cons: a template added on
     disk before the first turn appears only after a refresh or the first
     turn, as on every other attached Pi session.
6. **Recovering a preview discarded during an attach (Multi Review P1).**
   - Options: (a) clear `commandPreview` in the attach failure path; (b)
     publish the preview while an attach is pending and let a successful
     attach overwrite it; (c) mark the discarded preview and re-read on the
     next catalogue read under the same policy.
   - Chosen: (c).
   - Why: (a) spreads preview bookkeeping into the attach lifecycle and loses
     the "these rows came from a preview" marker for a `ready` preview; (b)
     can briefly publish rows that a concurrent attach is about to replace.
     (c) stays inside `command-preview.ts` and also covers a policy change or
     close while a read is in flight.
   - Pros: local to the preview module; a successful attach still clears the
     preview, so it can never overwrite attached rows. Cons: the retry waits
     for the next catalogue read rather than happening at the moment the
     attach fails.
7. **Container verification.** The picker spec gained a container variant
   (`ORKESTRATOR_AGENT_TEST_SLASH_ENVIRONMENT=container`, sharing
   `containerWorkspace` with `slash-command-inactive.spec.ts`), because the
   host run alone could not answer "Needs verification".

## Related

- [0016-slash-command-catalogue.md](0016-slash-command-catalogue.md): the
  picker qualification that found this.
- [0015-slash-command-qualification.md](0015-slash-command-qualification.md):
  the 2026-10-23 Pi probe ("Unattached session: `stale`, no rows").

## Replaces

Nothing; new work found on 2026-10-24.
