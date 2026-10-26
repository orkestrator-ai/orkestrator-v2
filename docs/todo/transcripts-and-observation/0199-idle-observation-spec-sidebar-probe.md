# Idle-observation live spec reads a retired sidebar marker

Checked against `main` at `930189337` (2026-10-26).

`e2e/agent-testing/idle-observation-live.spec.ts` decides what the sidebar
shows (`sidebarActivity`) by finding an `svg.shrink-0.transition-colors` next
to the environment's label and mapping its colour class through
`sidebarActivityFromClass` (`idle-observation-live-support.ts`): blue is
working, amber waiting, `text-success` idle. The environment row's marker is
now `EnvironmentStatusMarker` (`apps/web/src/components/environments/EnvironmentStatusMarker.tsx`,
changed on 2026-10-24, after the spec on 2026-10-23): a `span` with
`data-testid="environment-status-marker"` and `data-state` set to `working`,
`waiting`, `idle` or `inactive`, coloured red and yellow. No `svg` matches,
so every sidebar read returns `unknown`.

## Current state

- Found on 2026-10-26 while writing
  `container-claude-terminal-signal.spec.ts`
  ([0020](../containers-and-environments/0020-container-state-observation.md)):
  its first version copied this helper and never saw the sidebar show
  working. Reading `data-state` instead worked at once.
- In the idle-observation spec this means the `expect.poll` calls on the
  sidebar (the waits for working and for settling) time out, and the checks
  that the sidebar never showed working on an idle tab pass without looking.
  The spec itself was not rerun for this note: it needs live Claude and Codex
  turns (`ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION=1`).

## Outstanding work

### Code

1. Read the marker's `data-state` in `sidebarActivity`, map `inactive` to the
   spec's `stopped`, and replace `sidebarActivityFromClass` and its unit test
   in `idle-observation-live-support.test.ts`. The new spec's
   `sidebarActivity` is a working example.

### Qualification

- Rerun `idle-observation-live.spec.ts` against a live profile and confirm the
  sidebar cases now observe real states (and record any budget results they
  produce in
  [0049](0049-native-agent-idle-observation.md)).

## Constraints and rationale

- Prefer the marker's `data-state` over colour classes: the colours already
  changed once (blue/amber to red/yellow) and are a design choice, while
  `data-state` is what the marker's own tests pin.

## Open questions

None.

## Related

- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md)
  (the qualification this spec serves).
- [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md).
