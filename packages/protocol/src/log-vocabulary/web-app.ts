import { defineLogAreas } from "./define.js";

export const WEB_APP_LOG_AREAS = defineLogAreas({
  "web.app": {
    description: "The application root: startup checks and restoring state.",
    events: {
      "config.load-failed": "The application config could not be loaded.",
      "docker.check-failed": "A Docker availability probe failed; the result stays unknown.",
      "docker.checked": "A Docker availability check finished.",
      "docker.orphans-cleared": "Reconciling with Docker cleared orphaned container references.",
      "docker.sync-failed": "Reconciling environments with Docker failed; non-fatal.",
      "prompt-queues.restore-failed": "An environment's prompt queues could not be restored.",
      "multi-reviews.restore-failed": "An environment's multi reviews could not be restored.",
      "build-pipelines.restore-failed": "A project's build pipelines could not be restored.",
      "macos-permissions.check-failed": "Reading macOS file permission status failed.",
      "cli-check.failed": "One startup CLI check failed; its result stays unknown.",
      "cli-check.completed": "A startup CLI check finished; one line per tool.",
      "cli-check.retried": "A user-requested CLI recheck finished.",
      "cli-check.retry-failed": "A user-requested CLI recheck failed.",
      "exit.failed": "Exiting through the plugin failed; the window closes instead.",
      "zoom.native-failed": "Applying native zoom failed; the CSS fallback is used.",
      "github-cli.status-failed": "Reading the GitHub CLI setup status failed.",
      "attachments.restore-failed":
        "Saved prompt attachments could not be restored before startup.",
      "startup-launch.persist-failed": "Saving the startup agent launch failed; nothing started.",
      "environment.start-failed": "Starting an environment from the terminal overlay failed.",
      "project.delete-failed": "Deleting a project from its dialog failed.",
    },
  },
  "web.session": {
    description: "The renderer's terminal and agent session store.",
    events: {
      "status.update-failed": "A session status change could not be saved.",
      "activity.update-failed": "A best-effort session activity update failed.",
      "environment-sessions.disconnect-failed": "Disconnecting an environment's sessions failed.",
      "container-sessions.sync-failed": "Syncing sessions with container state failed.",
      "reorder.failed": "Reordering sessions failed; the list reloads from the backend.",
      "refresh.manual-failed": "A manual refresh of an agent tab failed.",
    },
  },
  "web.action-bar": {
    description: "The environment action bar.",
    events: {
      "editor.open-failed": "The external editor could not be opened.",
      "run-commands.read-failed": "Reading the project's run commands file failed.",
      "environment.delete-failed": "Deleting an environment from the action bar failed.",
      "merge.started": "A user-requested PR merge started.",
      "merge.completed": "A user-requested PR merge command returned.",
      "merge.failed": "A user-requested PR merge failed.",
    },
  },
});
