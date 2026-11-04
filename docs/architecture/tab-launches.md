# Tab launches and focus

Status: Living — when a tab appears and when it takes focus.

## The rules

1. **A tab a user launched has focus at once.** It does not wait for the backend.
2. **A tab created any other way does not take focus.** An agent, a coordinator
   or the CLI opening a tab leaves the user where they are.
3. **The setup terminal is the first tab**, and exists only when setup has
   something to show. With no setup script there is no terminal to lose.
4. **When setup finishes, the job tab launches and takes focus**, unless the user
   has opened another tab since setup started.
5. **⌘T always opens a tab**, wherever focus is, except while setup runs.

## Who owns what

The backend owns every tab: whether it exists, where it lands and what it shows.
The renderer owns one fact about a backend-owned launch, that the user launched
it from here, and that lives in `tabLaunchStore`, never in the pane layout.

| Piece | File |
| --- | --- |
| A launch, from press to arrival | `apps/web/src/lib/tab-launch.ts` (`beginTabLaunch`) |
| What is on its way | `apps/web/src/stores/tabLaunchStore.ts` |
| Placeholder tab and shimmer outlines | `apps/web/src/components/pane-layout/TabLaunchShimmer.tsx` |
| Focus when the tab arrives | `requestPaneTabActivation`, `flushPaneTabActivation` (`pane-layout-authoritative.ts`) |
| The setup tab | `ensureSetupTab` (`storage-sessions.ts`), published by `commands-environment.ts` |
| The job tab and its handoff | `ensureStartupNativeAgentTab`, `ensureTerminalJobTab`, `ensureBuildPipelineTab` |
| ⌘T | `new-agent-tab` in `APP_SHORTCUTS`; see [keyboard-shortcuts.md](keyboard-shortcuts.md) |

## A user's launch

The renderer chooses the tab id, so the placeholder and the tab are the same
thing, and passes it with the request:

1. `beginTabLaunch` adds the launch. The strip shows a focused placeholder, the
   pane shows shimmer outlines, and the tab that had focus stands down.
2. The backend writes the tab early. When the layout carrying it is installed the
   real tab replaces the placeholder, already focused.
3. The outlines stay over the tab until the request answers, because until then
   the session may not exist and the tab would look empty and ready to type in.

The request does not ask the backend to select the tab. Selection would race a
click the user made while the launch ran, and in a browser client, which adopts
the backend's selection, the launch would win. A launch that lands in a tab it
reused (an open Resolve tab) answers with that tab's id, and that tab takes focus.

Picking any other tab cancels the launch's claim on focus
(`cancelTabLaunchFocus`), and the tab arrives in the background. Picking its
placeholder takes the claim back.

Launches live outside React, so one survives its button unmounting or the user
switching environment. Each environment holds a bounded number, and an answered
launch whose tab never arrives is dropped after a grace period.

`claimTabLaunch` stops a double press. The claim outlasts a double press even
when the request answers first (Run's can answer in 50 ms), and a failed launch
releases it at once so it can be retried. The action names the chosen agent, so
picking a different one is a new launch.

## Environment start

`ensureSetupTab` runs when repository preparation streams output (a container's
clone) or just before setup commands run, so an environment with neither never
has the tab. It takes focus unless the user already has a tab of their own open.
Until a tab exists the renderer shows outlines (`EnvironmentTabsShimmer`) and adds
nothing itself.

The job tab is published when setup has settled, not when the launch was
requested, which keeps the terminal first and alone while it works. Its agent is
addressable before that: the mailbox directory lists `startup-agent` for an
environment with a pending launch, so mail sent during setup waits for it.

The handoff is decided twice, once per kind of client, and both read the same
rule: focus moves only from the setup terminal. The backend applies it to the
shared selection (`selectedTabIsSetupHandoffSource`). An Electron window owns its
selection, so it applies it when the job tab first arrives
(`applyStartupAgentSetupHandoff`), which also makes the handoff a one-shot.

`completeEnvironmentSetup` asks for the launch directly, and a request that lands
during another reconcile pass runs once more after it. That pass may have read
the environment before setup finished, and the sweep is two seconds away.

## Titles

`NativeAgentSessionTitles.resolve` never returns a provider's placeholder
("Agent Session"). A body-free state read has no first message to offer, so
answering with the placeholder overwrote the title the last transcript read had
shown, and the tab flapped between the two.
