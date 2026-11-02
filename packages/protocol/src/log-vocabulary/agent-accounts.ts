import { defineLogAreas } from "./define.js";

export const AGENT_ACCOUNTS_LOG_AREAS = defineLogAreas({
  "agent-accounts": {
    description: "Agent accounts: automatic switching, staged logins and plan usage.",
    events: {
      "switch-notice.failed":
        "A notice about an automatic account switch failed; the switch stands. `audience` says whose.",
      "auto-switch.check-failed": "An automatic account check failed; the next nudge retries.",
      "container-sync.failed":
        "Handing a login or account to a container failed; `step` says which part.",
      "last-usage.save-failed":
        "The last plan usage reading could not be saved; the next save retries.",
      "login-cleanup.failed": "A temporary login could not be cleaned up.",
      "login-refresh.deferred":
        "Containers were not told to refresh their login now; they reconcile from its durable generation.",
    },
  },
});
