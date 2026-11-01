import { defineLogAreas } from "./define.js";

export const UPDATER_LOG_AREAS = defineLogAreas({
  updater: {
    description: "Desktop self-update: electron-updater and updates a remote client requested.",
    events: {
      "channel.following": "Update checks now follow a different release channel.",
      "check-report.failed": "A check's result could not be reported.",
      "check.failed": "An update check failed; the next periodic check retries.",
      "download.failed": "Downloading or staging an update failed.",
      downloaded: "An update finished downloading.",
      "library.message":
        "One line from electron-updater at its own level. Its debug output, which includes the differential download plan, is off by default.",
      "remote.check-failed": "A check a remote client requested failed.",
      "remote.installing": "Installing an update for a remote client.",
      "remote.read-failed": "Update requests could not be read from the Local backend.",
      "remote.relaunch-prepare-failed": "Preparing the relaunch after a remote update failed.",
      "remote.relaunched": "The app relaunched to finish a remote client's update.",
      "remote.report-failed": "An update report could not reach the Local backend.",
      "remote.restart-not-recorded":
        "The backend did not record a restart, so it was not installed.",
      "remote.unavailable": "Updates requested by remote clients are unavailable in this session.",
      "restart-prompt.failed": "The restart prompt for a downloaded update failed.",
      unavailable: "Auto-update could not be set up in this session.",
      "update.failed": "electron-updater reported an update error.",
    },
  },
});
