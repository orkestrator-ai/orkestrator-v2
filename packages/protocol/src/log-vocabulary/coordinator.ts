import { defineLogAreas } from "./define.js";

export const COORDINATOR_LOG_AREAS = defineLogAreas({
  coordinator: {
    description: "Coordinators: delegations, status wakes and their store.",
    events: {
      "delegation.open-failed": "A delegation could not be opened; `source` says for what.",
      "deliver-now.drain-failed":
        "The mail delivery pass after deliverNow failed; the next sweep delivers.",
      "mail.move-failed": "Mail could not move to the new main coordinator.",
      "work.move-failed": "Work could not move to the main coordinator.",
      "wake.observe-remote-workflow-failed":
        "A remote workflow could not be observed for status wakes.",
      "wake.observe-pull-request-failed": "A pull request could not be observed for status wakes.",
      "wake.observe-feature-plan-failed": "A feature plan could not be observed for status wakes.",
      "wake.observe-workflow-failed": "A workflow could not be observed for status wakes.",
      "wake.deliver-failed":
        "A workflow status wake could not be delivered; the next pass retries.",
      "wake.waiting-check-failed": "A waiting worker could not be checked; the next pass retries.",
      "wake.resolve-report-failed": "A finished Resolve tab could not be reported.",
      "wake.waiting-report-failed": "A waiting worker could not be reported.",
      "wake.worker-outcomes-failed":
        "Coordinator-owned workers' merges and deletions could not be checked; the next sweep retries.",
      "pr-watch.added":
        "A pull request a coordinator conversation showed joined the project's watch; `source` says how.",
      "pr-watch.observe-failed":
        "A watched pull request could not be observed; the next sweep retries.",
      "pr-watch.read-failed":
        "GitHub could not be read for a watched pull request; `code` is the error category.",
      "store.malformed": "The coordinator store was malformed and is treated as empty.",
      "store.unsupported-version":
        "The coordinator store has an unsupported version and is treated as empty.",
      "store.invalid-workspace": "An invalid coordinator workspace record was ignored.",
      "store.workflows-cleared":
        "The workflow store was full, so a batch of its oldest finished records was removed.",
      "store.workflows-in-use":
        "The workflow store was full and every record was still in use, so new work was refused.",
      "remote-worker.settle-failed": "A remote worker could not be settled.",
      "checkout.merge-followed":
        "After an environment's PR merged, the project checkout was fast-forwarded, or `outcome` says why not.",
      "checkout.merge-follow-failed":
        "Fast-forwarding the project checkout failed, after an environment's PR merged or before mail woke the main coordinator.",
      "checkout.mail-follow":
        "Before mail woke the main coordinator, the project checkout was fast-forwarded, or `outcome` says why not (`timed-out`, `failed`).",
      "checkout.mail-follow-failed":
        "Before mail woke the main coordinator, checking whether to fast-forward the project checkout failed; the mail was delivered anyway.",
    },
  },
});
