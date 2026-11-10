import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const COORDINATOR_LOG_AREAS = defineLogAreas({
  coordinator: {
    description: "Coordinators: delegations, status wakes and their store.",
    events: {
      ...THROTTLE_LOG_EVENTS,
      "delegation.open-failed": "A delegation could not be opened; `source` says for what.",
      "delegation.reconcile-failed":
        "One delegation could not be settled; the rest of the pass still ran and the next one retries.",
      "delegation.wake-failed":
        "One delegation's wake could not be delivered; the rest of the pass still ran and the next one retries.",
      "delegation.wake-held":
        "A wake is waiting on a state the user can change (messaging off, conversation limit), and is not counted as a failure.",
      "delegation.wake-pass-failed":
        "A delegation wake pass could not run; the next sweep retries.",
      "delegation.wake-retire-failed":
        "A wake that keeps failing could not be given up on; the next pass retries.",
      "delegation.wake-retire-notice-failed":
        "The one notice for a wake being retired could not be sent; the wake stays owed and the next pass retries.",
      "delegation.wake-retired":
        "A wake kept failing and was given up on; `kind` is the last failure.",
      "mail.reconcile-failed":
        "One coordinator's mail could not be reconciled; the sweep carried on with the others.",
      "deliver-now.drain-failed":
        "The mail delivery pass after deliverNow failed; the next sweep delivers.",
      "mail.move-failed": "Mail could not move to the new main coordinator.",
      "work.move-failed": "Work could not move to the main coordinator.",
      "wake.observe-remote-workflow-failed":
        "A remote workflow could not be observed for status wakes.",
      "wake.observe-pull-request-failed": "A pull request could not be observed for status wakes.",
      "wake.observe-feature-plan-failed": "A feature plan could not be observed for status wakes.",
      "wake.observe-workflow-failed": "A workflow could not be observed for status wakes.",
      "notice.outbox-refused":
        "A leaf's outbox refused a coordinator notice, so its own coordinator takes it.",
      "notice.start-main-failed":
        "A coordinator notice could not start a main coordinator; it waits for one to open.",
      "notice.take-back-unread":
        "A notice handed back from a command node found no open coordinator here.",
      "limit-stop.own":
        "A coordinator's own usage-limit stop attempted to move it off the account.",
      "limit-stop.notice-failed":
        "A usage-limit notice could not be sent; it stays in the ledger for the next attempt.",
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
      "pr-watch.removed":
        "A watched pull request stopped being watched without a reading; `reason` is `deleted` (GitHub confirmed it is gone) or `unreadable` (not found for the give-up period).",
      "store.malformed": "The coordinator store was malformed and is treated as empty.",
      "store.unsupported-version":
        "The coordinator store has an unsupported version and is treated as empty.",
      "store.invalid-workspace": "An invalid coordinator workspace record was ignored.",
      "store.workflows-cleared":
        "The workflow store was full, so a batch of its oldest finished records was removed.",
      "store.workflows-in-use":
        "The workflow store was full and every record was still in use, so new work was refused.",
      "remote-worker.settle-failed": "A remote worker could not be settled.",
      "node-release.failed":
        "Work on a node that was forgotten or handed over could not be closed; the sweep's registry check retries.",
      "node-release.reconcile-failed":
        "The sweep could not check records against the node registry; the next sweep retries.",
      "node-release.unregistered":
        "Records named a node the registry no longer holds, so their work was closed here.",
      "node-release.notice-failed":
        "The notice for work closed on a released node could not be sent; it stays owed and the sweep retries.",
      "node-release.no-coordinator":
        "Work closed on a released node belonged to a coordinator that no longer exists, so nobody was told.",
      "node-offline.notice-failed":
        "The notice that a node has been unreachable for a day could not be sent; the next failed read retries.",
      "node-offline.check-failed":
        "Whether a long-unreachable node's coordinators were told could not be checked; the next read retries.",
      "node-reconnect.notice-failed":
        "The message that a node a coordinator tried while it was disconnected is back could not be sent; it is not retried, since the coordinator already holds the refusal.",
      "checkout.merge-followed":
        "After an environment's PR merged, the project checkout was fast-forwarded, or `outcome` says why not.",
      "checkout.merge-follow-failed":
        "Fast-forwarding the project checkout failed, after an environment's PR merged or before mail woke the main coordinator.",
      "checkout.mail-follow":
        "Before mail woke the main coordinator, the project checkout was fast-forwarded (`fast-forwarded-fetched` when the fetch was slow or failed and the upstream commit already fetched was merged), or `outcome` says why not (`timed-out`, `failed`).",
      "checkout.mail-follow-failed":
        "Before mail woke the main coordinator, checking whether to fast-forward the project checkout failed; the mail was delivered anyway.",
      "checkout.message-check":
        "Before a typed message to the main coordinator, the backend answered whether to fast-forward the project checkout: `outcome` (`offer`, `fast-forwarded`, `turn-running`, `not-behind`, `blocked`, `no-status`), `fetch` (`fetched`, `failed`, `timed-out`, `skipped`) and `durationMs`.",
      "checkout.message-check-failed":
        "Before a typed message to the main coordinator, fast-forwarding to the upstream commit already fetched failed after a slow or failed fetch; the message was sent anyway.",
    },
  },
});
