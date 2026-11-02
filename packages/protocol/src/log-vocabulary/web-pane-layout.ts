import { defineLogAreas } from "./define.js";

export const WEB_PANE_LAYOUT_LOG_AREAS = defineLogAreas({
  "web.pane-layout": {
    description: "Panes and tabs in the renderer: moves, splits, teardown and saved layouts.",
    events: {
      "persist.failed": "A pane layout could not be written to the backend.",
      "persist.install-skipped": "A saved layout was not installed: its dependencies did not load.",
      "persist.settled-handler-failed": "A write-settled handler threw; later handlers still ran.",
      "environment.activated": "The active environment changed.",
      "environment.initialized": "An environment's pane state was initialized.",
      "environment.initialize-skipped": "Initialize was called with no active environment.",
      "environment.terminals-cleared": "A reset cleared the environment's terminal instances.",
      "terminal-session.cleanup-started": "A closed tab's terminal session is being cleaned up.",
      "teardown.pending": "A tab teardown was rejected; the backend keeps it pending and retries.",
      "browser-preview.destroy-failed": "Destroying a closed browser tab's preview failed.",
      "handoffs.prune-failed": "Pruning unreferenced agent handoffs failed.",
      "tab.reactivated": "A tab added twice was activated in its existing pane instead.",
      "tab.move-started": "A tab move passed its checks and is being applied.",
      "tab.move-failed": "A tab move was refused; `reason` says which lookup failed.",
      "tab.initial-prompt-cleared": "A tab's initial prompt was cleared.",
      "tab.initial-agent-options-cleared": "A tab's initial agent options were cleared.",
      "pane.split-depth-reached": "A split was refused at the maximum split depth.",
      "pane.edge-split-started": "An edge split passed its checks and is being applied.",
      "pane.edge-split-failed": "An edge split was refused; `reason` says which lookup failed.",
      "pane.close-refused": "Closing the only pane in a layout was refused.",
      "draft.discard-failed": "A closing tab's draft could not be discarded; the tab stayed open.",
      "draft.file-conflict-resolve-failed": "Discarding a newer saved file draft failed.",
      "draft.compose-conflict-resolve-failed": "Discarding a newer saved compose draft failed.",
    },
  },
});
