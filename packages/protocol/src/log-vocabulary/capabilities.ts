import { defineLogAreas } from "./define.js";

export const CAPABILITIES_LOG_AREAS = defineLogAreas({
  capabilities: {
    description:
      "Agent Capabilities: package inspection, fleet reconciliation, update checks and the per-machine executor.",
    events: {
      "reconcile.failed":
        "A machine's reconcile pass failed; the next trigger or the timer retries.",
      "reconcile.scoped-failed":
        "Delivering worktree or added-account copies failed; the next reconcile pass retries.",
      "updates.check-failed": "The periodic update check failed; the next interval retries.",
      "updates.package-check-failed":
        "Checking one package for updates failed; the others continue.",
      "command.refused":
        "A capability command was refused with a structured reason (`code`, `ref`).",
      "command.failed":
        "A capability command failed unexpectedly; `ref` is the reference the user sees.",
      "service.preflight-failed":
        "Resolving a session's capabilities at launch failed; the session starts without the check.",
      "service.init-failed":
        "The capability service could not start; capability pages answer with an error.",
      "launch.request-failed":
        "A leaf could not ask its command node to resolve a launch; it falls back to its last answer or fails closed.",
      "launch.answer-failed":
        "The command node could not answer a leaf's launch request; the leaf falls back.",
    },
  },
});
