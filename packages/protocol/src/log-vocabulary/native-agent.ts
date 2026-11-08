import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const NATIVE_AGENT_LOG_AREAS = defineLogAreas({
  "native-agent": {
    description: "Native agent sessions and what the backend reads from their bridges.",
    events: {
      "session.bridge-replaced-for-policy":
        "An idle bridge was stopped so a resume could apply the user's wider execution policy.",
      "catalogue.outdated-bridge":
        "A bridge predates the command catalogue, so its commands stay unavailable.",
      "compact.instructions-ignored":
        "A bridge compacted without confirming the instructions sent with /compact: it predates them.",
      "handoff.summary-read-failed":
        "Change summaries could not be read for a handoff, so the carrier says they are unmeasured.",
      "handoff.consume-failed": "A delivered handoff could not be marked consumed.",
      "job.pr-refresh-rollback-failed": "Rolling back a pull request refresh for a job failed.",
      "job.resend-queue-failed": "A resend could not be queued for a job.",
      "interaction.requests-dropped": "Interaction requests that could not be mapped were dropped.",
      "interaction.observe-failed": "Observing a session's interactions failed. Error class only.",
      "human-prompt.listener-failed": "A human prompt listener threw; the others still run.",
      "question.attention-record-failed":
        "Attention for an async question could not be recorded; the transcript stays readable.",
      "activity.reconcile-failed":
        "Reconciling an environment's activity failed. Error class only.",
      "activity.persist-failed": "An environment's activity could not be saved.",
      "pr-refresh.schedule-failed":
        "A pull request refresh after completion could not be scheduled.",
      "launch.startup-failed": "A startup launch failed; it retries unless `permanent`.",
      "queue.failing":
        "A native prompt queue keeps failing. The key and reason only, never the prompt.",
      "provider.retire-failed": "Retiring an obsolete provider failed.",
      "workflow-result.store-unavailable":
        "The workflow result store is unavailable, so the provider's result is used.",
      "catalogue.refresh-failed": "A provider's command catalogue could not be refreshed.",
      "dispatch.attach-failed":
        "Attaching an agent before dispatch failed; the prompt request answers authoritatively.",
      "coordinator-context.ack-failed": "Coordinator repository context could not be acknowledged.",
      "naming.prepare-failed":
        "First-prompt naming could not be prepared; the prompt still goes ahead.",
      "interrupt.persist-failed":
        "A turn interrupt could not be saved, so automatic publication stays fenced.",
      "resume.close-replaced-failed": "The session a resume replaced could not be closed.",
      "sign-in.check-failed": "A turn could not be checked for a login refusal.",
      "sign-in.resend-failed": "Sending refused prompts after sign-in failed.",
      "sign-in.prompt-resend-failed":
        "One refused prompt could not be sent again after sign-in. Error class only.",
      "shutdown.checkpoints-skipped":
        "Shutdown skipped display-tail checkpoints; provider history stays authoritative. Count only.",
      "turn-recovery.failed": "Recovering an incomplete turn failed.",
      "turn-recovery.exhausted":
        "A turn failed again after automatic recovery and is left for the user.",
      "turn-recovery.retrying":
        "An incomplete or provider-failed turn is being retried automatically.",
      "usage-limit.notice-failed": "A usage-limit stop's outcome could not be read for its notice.",
      "usage-limit.resend-failed":
        "Resending after a usage limit failed. An unknown send stays in the journal.",
      "title.strategy-failed":
        "A session title strategy failed, so the next is tried. Content-free: the error can quote the prompt.",
      "steer.qualification-failed":
        "A bridge's steer qualification failed or answered non-OK, so steering is not offered. Agent and status code or error class only.",
      "steer.capability-cleared":
        "A projection cleared `actions.steer` because its bridge did not qualify. Identifiers and turn status only.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
  "native-agent.goal": {
    description: "The /goal loop: advancing goals and their verifiers.",
    events: {
      "advance.failed": "A goal could not advance; the next sweep retries.",
      "attention.record-failed": "Attention for a goal could not be recorded.",
      "turn-end.settle-failed": "Turn-end work for a goal could not be settled.",
      "verifier.finish-failed":
        "A verifier failed to finish; the goal stays verifying, so the next sweep runs it again.",
      "verifier.stop-failed": "An earlier verifier could not be stopped.",
      "recover.failed": "Goals could not be recovered at startup.",
    },
  },
  "native-agent.subork": {
    description: "Suborks: the ask_agents calls a native agent makes. Content-free.",
    events: {
      "pass.failed": "A pass over a call failed, so a later pass retries. Counts only.",
      "delivery.failed":
        "A call's answers could not be placed in the caller's mailbox yet. Error class only.",
      "retention.failed": "An old call could not be removed.",
      "sweep.failed": "A running call's caller could not be checked; the next sweep looks again.",
    },
  },
  "native-agent.opencode": {
    description: "The OpenCode provider: its request monitor, retries and agent tools.",
    events: {
      "retry.abort-failed": "Aborting an automatic retry failed. Error class only.",
      "retry.abort-not-scheduled":
        "An automatic retry abort could not be scheduled. Error class only.",
      "agent-tools.unavailable": "OpenCode agent tools remain unavailable for a session.",
      "coordinator-servers.unavailable": "OpenCode coordinator research servers are unavailable.",
      "monitor.reconnecting":
        "The request monitor lost its stream and is reconnecting. Error class only.",
      "worker-limit.reached":
        "The bounded request workers are full, so the stream restarts and a snapshot reconciles.",
      "request.failed":
        "Handling a request event failed, so the stream restarts. Error class only.",
      "credential-plugin.skipped":
        "A host OpenCode server started without the credential plugin, so its tools inherit its password; `reason` says why.",
      "host-database.separated":
        "Host OpenCode uses Orkestrator's own database because the shared one has no `session` table (an OpenCode 2 database); `reason` says why.",
      "host-database.unreadable":
        "The shared OpenCode database could not be inspected, so host OpenCode opens it as usual. Error class only.",
    },
  },
  "native-agent.opencode2": {
    description: "The OpenCode 2.x provider: its event monitor, steering, routing and host server.",
    events: {
      "events.dropped":
        "The 2.x event stream ended or failed, so reads go to the server until it reconnects. Error class only.",
      "steer.unconfirmed":
        "A 2.x steer got no definite answer, so its delivery is reconciled from history. Error class only.",
      "provider.dispose-failed":
        "Disposing the 2.x provider of a replaced server failed. Error class only.",
      "host-server.ready":
        "A local environment's 2.x server answered `/api/info` as 2.x. Environment id and pid only.",
      "host-server.terminate-failed":
        "A 2.x server that did not become ready could not be stopped; its process entry is kept for shutdown. Error class only.",
    },
  },
});
