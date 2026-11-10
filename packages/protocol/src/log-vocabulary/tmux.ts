import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const TMUX_LOG_AREAS = defineLogAreas({
  tmux: {
    description: "Claude tmux tabs: launch, the poll loop, cleanup and the tmux prompt queue.",
    events: {
      "poll.discovery-failed": "Finding the session's transcript failed; a later tick retries.",
      "poll.snapshot-failed":
        "Reading the hook and transcript state failed; the next tick retries.",
      "poll.drain-pending-failed": "Delivering pending hook events failed; the next tick retries.",
      "poll.drain-timeouts-failed": "Delivering hook timeouts failed; the next tick retries.",
      "poll.tail-failed": "Reading new transcript lines failed; the next tick retries.",
      "cleanup.session-stop-failed":
        "A tmux session could not be stopped while cleaning up an environment.",
      "cleanup.skipped":
        "Environment tmux cleanup was skipped because tmux could not be reached and nothing required it.",
      "cleanup.environments-load-failed":
        "Environments could not be loaded during tmux cleanup, so it stays incomplete.",
      "cleanup.kill-failed": "An environment's tmux sessions could not be killed.",
      "cleanup.kill-incomplete":
        "An environment's tmux sessions could not all be shown gone (a session survived, or the socket was unreachable while another tmux process might own it), so cleanup stays incomplete.",
      "hooks.uninstall-failed": "Workspace hooks could not be uninstalled.",
      "hooks.git-exclude-failed": "The git exclude for Claude's local settings could not be set.",
      "naming.prepare-failed":
        "First-prompt naming could not be prepared; the prompt still goes ahead.",
      "orphans.skipped": "Orphan reconciliation was skipped because pane layouts are unreadable.",
      "orphan.reaped": "A tmux session no tab references was killed.",
      "orphan.kill-skipped":
        "An orphan tmux kill was skipped because the tmux server could not be reached.",
      "cli.thinking-display-probe-failed":
        "Probing the CLI for --thinking-display failed, so it launches without it.",
      "cli.fast-mode-unsupported":
        "The claude CLI lacks --settings, so it launches without fast mode.",
      "cli.effort-unsupported": "The claude CLI lacks --effort, so it launches without it.",
      "interactive.snapshot-failed":
        "An interactive snapshot failed; expected while a pane is closing.",
      "signal.arm-failed": "The Claude state signal could not be armed.",
      "signal.degraded":
        "The Claude state signal missed a change or rang too often, so polling stays at one second until it is re-armed.",
      "hook-signal.arm-failed": "The tmux hook doorbell could not be armed.",
      "hook-signal.degraded":
        "The tmux hook doorbell missed a hook, so idle tabs poll every second until it is re-armed.",
      "pr-refresh.schedule-failed": "A pull request refresh after a turn could not be scheduled.",
      "pr-probe.failed": "Probing for a pull request an agent created failed.",
      "activity.persist-failed": "Tmux tab activity could not be saved.",
      "fast-mode.persist-failed": "The launch fast mode could not be saved.",
      "fast-mode.repair-failed":
        "Fast mode metadata could not be repaired on a reattached session.",
      "pane.observe-failed":
        "A pane observation failed. Error class only: pane contents are sensitive.",
      "turn.failure-record-failed": "A failed turn could not be recorded.",
      "slash-command.settle-timeout": "Timed out waiting for a Claude slash command to settle.",
      "queue.failing": "A tmux prompt queue keeps failing to dispatch.",
      "queue.rename-failed":
        "An environment could not be named from its first prompt; the prompt still goes ahead.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});
