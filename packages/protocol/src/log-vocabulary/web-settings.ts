import { defineLogAreas } from "./define.js";

export const WEB_SETTINGS_LOG_AREAS = defineLogAreas({
  "web.settings": {
    description: "The settings screens.",
    events: {
      "self-improvement.status-failed": "Settings → Self-improvement could not read the status.",
      "self-improvement.projects-failed":
        "Settings → Self-improvement could not list the projects.",
      "self-improvement.save-failed": "Settings → Self-improvement could not save a setting.",
      "self-improvement.run-failed": "Settings → Self-improvement could not start a run.",
      "config.save-failed": "Global settings could not be saved.",
      "config.load-failed": "The settings page could not load the config.",
      "config.reload-failed": "Re-reading the workspace config after a save failed.",
      "domains.test-failed": "The domain resolution test could not run.",
      "github-credentials.propagate-failed":
        "Propagating GitHub credentials to environments failed.",
      "credential.save-failed": "A credential could not be saved.",
      "credential.clear-failed": "A credential could not be cleared.",
      "gateway-token.save-failed": "The gateway token could not be saved.",
      "gateway-token.copy-failed": "Copying the gateway token to the clipboard failed.",
      "web-client-url.copy-failed": "Copying the web client address to the clipboard failed.",
      "backend-version.read-failed": "The debug tab could not read the backend version.",
      "messaging.flush-failed": "Saving pending messaging settings on unmount failed.",
      "directory-picker.failed": "The repository directory picker could not open.",
      "file-picker.failed": "The repository file picker could not open.",
      "repository.save-failed": "Repository settings could not be saved.",
      "model-catalogues.read-failed": "Reading the model catalogues for settings failed.",
    },
  },
});
