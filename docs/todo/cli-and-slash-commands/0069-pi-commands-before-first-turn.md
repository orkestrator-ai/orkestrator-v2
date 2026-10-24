# Pi commands before the first turn

Checked against `main` at `8454d18b` (2026-10-24).

A new Pi tab's `/` menu lists none of Pi's own commands (templates, skills,
extension commands) until its session attaches, which happens at the first
turn or when the user presses "Refresh commands" in the menu. Until then it
shows only Orkestrator's `/steer` and `/compact` with "This list may be out
of date".
Every other provider lists its commands before the first turn: Claude from a
control-only probe, Codex from `skills/list`, OpenCode from `command.list`,
and Grok from its push after `session/new`. Found by the live picker run in
[0016](0016-slash-command-catalogue.md) on 2026-10-24.

## Current state

- The Pi bridge creates a session record on `POST /session/create` but builds
  the Pi `AgentSession` (resources, extensions, the command list) only on
  attach (`ensureSession` in `bridges/pi-bridge/src/agent-session.ts`).
- Attach happens when a turn is about to run: the backend's
  `HttpBridgeProvider.prepareDispatch` posts `/session/:id/attach` before a
  dispatch (`apps/backend/src/core/http-bridge-provider.ts`), and the prompt
  route attaches too.
- Until then the session's catalogue is `stale` with no rows
  (`session-factory.ts` seeds `{ status: "stale" }`). Catalogue reads are
  metadata by contract and never attach. An explicit refresh does attach
  (`refreshSessionCommands` calls `ensureSession`) and answers `reloaded`, so
  the menu's "Refresh commands" button, shown for a stale list, is a working
  manual path; nothing tells the user to press it.
- After the first attach the list is `ready`, survives an idle detach (10 min,
  `idle-detach.ts`) as `stale`, and is read afresh on the next attach.
- Evidence, live, Pi SDK 1.4.0, profile `qa-picker-0016`, host worktree with
  `projectResources: true` and two `.pi/prompts` templates
  (`e2e/agent-testing/slash-command-picker.spec.ts`, step "before it
  attaches the session lists no provider commands; the picker's refresh
  attaches it"): catalogue `stale`, rows
  `/compact` and `/steer` only, for the whole 180 s wait in an earlier run.
  Either one short turn (about 3 s) or the menu's "Refresh commands" attached
  the session; both templates were then listed under "Templates", and a
  template added on disk appeared after a refresh (`reloaded`).

## Outstanding work

### Code

1. **List Pi's commands before the first turn without breaking the metadata
   contract.** Options to weigh:
   - attach when the tab opens (`POST /session/create` or the renderer's
     `ensureNativeAgentSession`), which loads extensions and so runs extension
     code before the user asked for anything;
   - a resource-only read that discovers templates and skills without binding
     extensions (Pi's resource loader, if the SDK exposes one), with
     extension commands added at attach;
   - attach on the first picker open rather than the first catalogue read,
     as the refresh button already does;
   - keep it, but say so in the picker ("Refresh to load Pi's commands")
     instead of the generic stale line.
   Never seed or guess rows, and a catalogue read must still not attach.

### Qualification

- Re-run `slash-command-picker.spec.ts` for Pi after the change, without its
  attaching refresh step.

## Constraints and rationale

- Catalogue reads are metadata: they must not touch `lastAccessed`, hydrate a
  transcript or re-attach an idle session
  ([`native-agent-commands.md`](../../architecture/native-agent-commands.md)).
- Pi's `reload()` and extension binding run extension code; anything that
  attaches early must respect the busy rules in the Pi provider notes.

## Open questions

- Does Pi 1.4.0 expose resource discovery (templates and skills) without a
  bound `AgentSession`?

## Needs verification

- Whether a container Pi tab behaves the same (only a host worktree was run).

## Related

- [0016-slash-command-catalogue.md](0016-slash-command-catalogue.md): the
  picker qualification that found this.
- [0015-slash-command-qualification.md](0015-slash-command-qualification.md):
  the 2026-10-23 Pi probe ("Unattached session: `stale`, no rows").

## Replaces

Nothing; new work found on 2026-10-24.
