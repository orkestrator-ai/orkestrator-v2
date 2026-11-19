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
      "service.preflight-failed": "Resolving a session's capabilities failed before launch.",
      "service.launch-record-failed":
        "The capability decision could not be recorded after verification.",
      "delivery.scope-failed": "A worktree or account delivery pass failed.",
      "service.init-failed":
        "The capability service could not start; capability pages answer with an error.",
      "launch.request-failed":
        "A leaf could not ask its command node to resolve a launch; it falls back to its last answer or fails closed.",
      "launch.answer-failed":
        "The command node could not answer a leaf's launch request; the leaf falls back.",
      "leaf-request.failed":
        "A leaf could not ask its command node for a container manifest or an environment card; it falls back.",
      "leaf-request.answer-failed":
        "The command node could not answer a leaf's container or environment-card request; the leaf falls back.",
      "container.artifact-transfer-failed":
        "An artifact of a leaf's container manifest did not reach the leaf; that component is recorded as not staged.",
      "container.staged-from-cache":
        "A leaf's command node was unreachable at container creation; its last manifest for that container was staged.",
      "container.unstaged":
        "A leaf's command node was unreachable at container creation and nothing was cached; no capabilities were staged.",
      "environment-card.container-read-failed":
        "The command node could not read a container's staged record from its machine; the card says so.",
    },
  },
});
