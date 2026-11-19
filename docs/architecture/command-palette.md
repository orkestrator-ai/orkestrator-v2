# Command palette (⌘K)

Status: Living. The ⌘K / Ctrl+K palette as built: one entry point for
destinations (projects and environments on every machine), actions, precise
settings and history: open tabs, messages loaded in open agent tabs, and past
conversations.

⌘K, and the sidebar's "Search projects, environments..." field, open the same
dialog (`ProjectSearchBar`). Its project and environment search is unchanged
and is described in [federation.md](federation.md#project-search); this page
covers what the palette adds around it.

## What it shows

Opening the palette shows a context line, then results in a fixed group order:

1. **Context.** The machine, project and environment the palette was opened
   over (`command-palette-context`). Commands act on this target.
2. **Projects and Environments** (the destinations): recents on an empty
   query, matches otherwise, exactly as before.
3. **Actions**: on an empty query, recently used commands and the context's
   *suggested* actions that can run now ("Suggested actions"); with a query,
   every matching action, available ones before unavailable ones.
4. **Settings**: Settings sections and the target's environment and
   repository settings.
5. **History**, three sources searched asynchronously, each under its own
   heading and status:
   - **Open tabs**: the open conversation, terminal and view tabs on the
     context's machine.
   - **Messages**: messages already loaded in that machine's open agent tabs
     that contain every word typed. Opening one opens its tab scrolled to the
     message.
   - **Past sessions**: the context environment's conversations its agents can
     resume, as the agent tab's "Resume session" picker lists them. Opening
     one resumes it in a new agent tab.

Alt+Down and Alt+Up cycle the category filter (All, Projects, Environments,
Actions, Settings, History); the Filter menu has the same list plus the
machine filter, which narrows commands by their target's machine as it
narrows destinations. An empty query in a command category lists the whole
group. Group order never changes, so a late answer can only add rows at the
end.

Every action row names its target (environment · project) and, in a
multi-machine view, its machine badge with the offline/stale/loading marker.
Its accessible name says the same: `"Stop environment, for build-modal-steps ·
orkestrator-v2, on mbp3"`. A row that asks first says "asks first"; a row with
an app shortcut shows it.

## The command model

| Piece | File |
| --- | --- |
| Descriptor, target, availability, filters, runtime interface | `apps/web/src/lib/command-palette/model.ts` |
| Every command and the action it delegates to | `apps/web/src/lib/command-palette/catalog.ts` |
| Context from the frozen selection and live sources | `apps/web/src/lib/command-palette/context.ts` |
| Ranking, machine scope, recents | `apps/web/src/lib/command-palette/search.ts` |
| Asynchronous providers, generations | `apps/web/src/lib/command-palette/providers.ts` |
| History result types, open-tabs provider | `apps/web/src/lib/command-palette/history.ts` |
| Messages provider (loaded transcripts) | `apps/web/src/lib/command-palette/history-messages.ts` |
| Past-sessions provider (resume lists) | `apps/web/src/lib/command-palette/history-sessions.ts` |
| History destinations: message scroll, resume in a new tab | `apps/web/src/lib/command-palette/history-destinations.ts` |
| Resume request a new agent tab reads on mount | `apps/web/src/lib/native-agent-resume-requests.ts` |
| Selection by row identity | `apps/web/src/lib/command-palette/selection.ts` |
| Settings sections, labels and aliases (shared with Settings' menu) | `apps/web/src/lib/settings-catalog.ts` |
| React context, runtime, History hook, measurement | `apps/web/src/components/command-palette/useCommandPalette.ts` |
| Rows, context line, confirmation | `apps/web/src/components/command-palette/CommandPaletteParts.tsx` |
| Recent command IDs | `apps/web/src/stores/commandPaletteStore.ts` (a window store) |

A `CommandDescriptor` has a stable `id`, a label, curated aliases, a group,
an effect (`navigation`, `read` or `mutation`), what it `requires` (window,
project or environment), optional `confirm`, `hidden` and `availability`
rules, and `run(target, runtime)`. Typed text is only ever matched against
labels and aliases; it is never run.

Each command calls an action the app already has, through `CommandRuntime`,
which the palette's host builds from the same handlers:

| Commands | Same path as |
| --- | --- |
| Start / Stop environment | The sidebar row's menu: `useEnvironments` handlers for this window's machine, `runFederatedEnvironmentPower` for another machine's (also what `useFederatedEnvironmentActions` calls) |
| Environment settings, Rebuild container (keep work) | The row's Settings item: `openMachineWorkspace({ dialog })` |
| Open changes, Browse files | The Files panel's tabs on the target's node scope |
| New environment, Repository settings, Open project home / coordinator / Kanban / GitHub | The project's menu and board tabs: `openMachineWorkspace` |
| New agent tab, Show keyboard shortcuts, Change sidebar grouping | `requestAppShortcut`, the handler ⌘T, ⌘⇧/ and ⌘⇧D run |
| Settings sections | `requestGlobalSettings`, like every other link into Settings |
| Add project | The sidebar's Add Project dialog |

`context.test.ts` runs every command against a recording runtime and checks
the call it makes.

### Availability

`commandAvailability` decides, in order: the target exists (`no-environment`,
`no-project`, `target-missing`), or is unknown because its machine has not
reported it (`target-unknown`: an offline, stale or loading machine's absent
row is not a deletion); the machine accepts writes when the command needs it
(`machine-offline`; mutations by default, plus dialogs that write, as the
row's Settings item is disabled offline); then the command's own rule.
Environment power uses `environmentRowModel(facts).menu`, the decision the
row's menu makes, built from the row's own fact builders
(`localEnvironmentRowFacts`, `nodeEnvironmentRowFacts`);
`environmentPowerAvailability` names the first prerequisite that fails
(`busy`, `transitioning`, `docker-unavailable`, `not-running`).

An unavailable command stays listed when it matches, with its reason and a
next step: choose an environment or project (clears the query and switches the category filter),
open Machines or Docker settings, start the environment, or use the
environment now shown. Enter or a click on such a row follows the next step;
a power recovery step opens its own confirmation. Commands that cannot apply at all (Start on
a running container, any container command on a local environment, a Settings
section whose experimental flag is off) are hidden instead.

The backend owner still validates when an action runs. The palette never
re-implements permissions.

### Frozen targets

The palette freezes the window's node-qualified selection
(`windowSelectionStore`) when it opens. Commands act on that machine, project
and environment by ID whatever the window shows later; names and states are
looked up from the IDs on every render, never the reverse, so a namesake on
another machine is never chosen. When the window moves, the context line says
so and offers "Use what is shown", the only way to retarget.

A command with `confirm` opens a confirmation inside the palette naming the
environment, project and machine. When confirmed it re-reads availability
for the same frozen target and refuses (showing why, running nothing) if the
target went away, changed or became unavailable. Keyboard confirmation needs
a fresh Enter press. Escape leaves the confirmation and a second Escape
closes the palette.

### Running, failures and duplicates

A command runs once. The palette closes, and the result appears where that
action reports it: a toast, the row's state, the opened dialog. The palette
never retries: a failure or a lost answer (`OutcomeUnknownError` for another
machine) is reported by the owner without resending, and repeating is the
user's call. This client claims an environment while a power action runs
(`sidebarActionStore`), so a second activation from this window is ignored.
Two windows or clients activating the same command reach the owner twice;
the owner's own state checks (a stopped container is not stopped again) and
operation records decide, not the palette.

Closing the palette does not cancel anything it started: actions run in the
backend and their state comes back through the normal snapshots.

## Asynchronous results

A provider (`PaletteProvider`) answers a query later. `PaletteQueryRunner`
runs one request; the History hook makes one runner per source, query and
owner snapshot and disposes it in the effect cleanup, which aborts the scan and
discards any late answer. `providerView` shows `loading` until the answer for
the current request arrives, so an older query's rows are never shown under a
newer one. Each provider reports `loading`, `ready`, `partial` (bounded scan)
or `failed` on its own group heading.

The highlight is a row identity (`selection.ts`): the row the user chose, else
the row pinned when the query's results first appeared, else the first row.
Rows inserted later, above or below, do not move it, so Enter opens what was
highlighted. Only when that row disappears does the highlight move, visibly,
to the first row. Enter while an IME composition is open commits the text and
runs nothing.

### History sources

**Open tabs** reads only tab chrome (type, display title, a pull request's
title, a file's name) from the context machine's pane layouts, the context
environment first, at most 400 layouts and 400 tabs scanned and 20 results
returned, yielding to input every 100.

**Messages** reads the messages each open agent tab already holds in its node
scope's `nativeAgentProjectionStore`; it fetches nothing, so earlier pages a
tab has not loaded, and tabs that have loaded nothing, are not searched. Only
user and agent messages count, and only for a non-empty query: every word must
appear. It reads at most 2,000 messages (newest first in each tab) and the
first 8,000 characters of each, returns at most 12 rows and 3 per tab, and
yields every 200 messages. A row shows a one-line excerpt around the match;
the query and the excerpt are display state only, never logged, stored or put
in the command catalogue. Opening a row parks a `conversationScrollTargetStore`
request (the one "Open full conversation" uses) and then opens the tab, so the
chat scrolls to the message and highlights it once it is shown, or drops the
request after its bounded wait.

**Past sessions** calls `list_native_agent_resumable_sessions`, the resume
picker's own list, on the context environment's machine, once per palette
session and platform; typing filters that answer locally. It lists only the
platforms the environment already has an agent tab for, because listing
resolves the platform's bridge and a search must not start one. It needs a
running environment on a writable machine. Reconnecting the machine reloads
its lists. The search excludes archived conversations and matches open tabs
by platform and live session ID, including OpenCode 2.x's prefixed resume IDs.
Providers with opaque resume handles can still return open conversations.
One failing platform marks the group `partial`. If all fail, the group reports
`failed`. Search reads titles from the provider list.

Opening a past session adds an agent tab for that platform to the context
environment (refused, with a reason, while setup runs, at the tab limit or
when the environment is not running), parks a resume request for it
(`native-agent-resume-requests.ts`: keyed by node, environment and tab,
bounded, expiring after a minute if the tab never reads it), and saves the layout.
The new tab reads the request on mount and waits for the save before running
the picker's own resume handler with the chosen conversation. A failed layout
save offers to retry the same tab and conversation. Closing the tab cancels its
parked resume. The picker's existing error path reports resume failures.
The tab opens on the frozen target even when the window switches environments.

## Keyboard, pointer, touch and focus

Arrow keys move, Enter runs or opens, Alt+Up and Alt+Down change category, and Escape backs out. Tab moves focus
to controls such as the filter menu and context refresh. If a selected History
row disappears during refresh, Enter waits for that row to return or for the
user to select another result.
Every row is a button, so a pointer or touch reaches every command, including
an unavailable row's next step and the confirmation's buttons. Focus returns
to where it was when the palette opened (the trigger, a composer, a
terminal) when dismissed or after an action without a focus destination.
Rows show a wrapping target line on narrow screens and a chip from the `sm`
breakpoint up. The accessible name always carries the target.

## Recents and privacy

`commandPaletteStore` keeps at most 8 recent command IDs per window (stable
catalogue IDs only: never a target, a name or the query), and whether to keep
them. "Clear recent commands" and "Stop remembering recent commands" are
commands. Recent destinations are the sidebar's node-qualified recents
([federation.md](federation.md#project-search)). The query lives only in
component state.

## Measurement

The `web.command-palette` log area writes, when the palette closes, one
`session.closed` entry: what was activated (a static command ID,
`destination.project`, `destination.environment`, or `history.tab`,
`history.message` or `history.session`), milliseconds
from opening to activation, how long it was open, how many queries found
nothing, and how many unavailable commands were chosen. `command.unavailable`
records a chosen unavailable command's ID and reason category, and
`command.revalidation-failed` a confirmation the re-check refused. No query,
name, ID of a project or environment, or parameter is logged. No numerical
targets are set yet: they wait for a baseline from these entries.

## Not built

- A backend-side transcript index (plan item 11): Messages searches only what
  open tabs have loaded, so a closed conversation is found by its title under
  Past sessions, not by its text. A backend search can be added as another
  History source behind the same provider interface.
- A shared back/forward destination stack (plan item 16): the
  `openMachineWorkspace` destination contract is where it plugs in.
- Starting a preview service: Orkestrator registers services that a terminal
  or agent starts; it has no start action to delegate to. Browser previews'
  settings are reachable ("Browser previews").
- Delete environment: the row's delete dialog carries notices (pull request,
  design) the palette does not reproduce.
- Restart environment: the palette can offer it once the owning backend can
  record the full operation before stopping the container.
