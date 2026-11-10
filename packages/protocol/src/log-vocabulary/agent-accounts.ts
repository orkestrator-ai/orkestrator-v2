import { defineLogAreas } from "./define.js";

export const AGENT_ACCOUNTS_LOG_AREAS = defineLogAreas({
  "agent-accounts": {
    description: "Agent accounts: automatic switching, staged logins and plan usage.",
    events: {
      "limit-stop-notice.failed": "A session's usage-limit stop could not be reported.",
      "switch-notice.failed":
        "A notice about an automatic account switch failed; the switch stands. `audience` says whose.",
      "auto-switch.check-failed": "An automatic account check failed; the next nudge retries.",
      "kept-note.failed":
        "Recording why a limit stop found no account to move to failed; the stop stands.",
      "container-sync.failed":
        "Handing a login or account to a container failed; `step` says which part.",
      "last-usage.save-failed":
        "The last plan usage reading could not be saved; the next save retries.",
      "shared-usage.save-failed":
        "The shared usage readings could not be saved; they stay in memory and the next reading saves them.",
      "shared-usage.record-failed":
        "A fresh usage reading could not be kept for sharing with other machines; the account's own reading stands.",
      "login-cleanup.failed": "A temporary login could not be cleaned up.",
      "login-renewal.failed":
        "Renewing an idle account's sign-in to read its usage failed; it is retried after a backoff.",
      "login-renewal.not-extended":
        "Claude Code ran to renew an idle account's sign-in, but its token is still lapsed.",
      "login-refresh.deferred":
        "Containers were not told to refresh their login now; they reconcile from its durable generation.",
    },
  },
});
