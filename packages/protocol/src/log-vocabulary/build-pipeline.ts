import { defineLogAreas } from "./define.js";

export const BUILD_PIPELINE_LOG_AREAS = defineLogAreas({
  "build-pipeline": {
    description: "Build pipelines: their supervision, stages, transcripts and sidebar state.",
    events: {
      "sidebar.reconcile-failed": "Sidebar activity for pipelines could not be reconciled.",
      "sidebar.update-failed": "The sidebar could not be updated for one pipeline.",
      "result.consume-deferred":
        "Consuming a stage's workflow result failed; it stays staged and is retried.",
      "consolidation.consume-deferred":
        "Consuming a review consolidation result failed; it stays pending and is retried.",
      "dispatch.prepare-failed":
        "Attaching the agent before dispatch failed; the prompt request does the same work and answers authoritatively.",
      "interaction.resolved": "A human interaction on a pipeline stage resolved. Metadata only.",
      "user-message.background-send-refused":
        "The bridge refused a queued user message during a background wait; it stays queued and is retried.",
      "transcripts.migrated": "A transcript migration pass moved stage transcripts; counts only.",
      "transcripts.maintenance-failed":
        "Migrating or sweeping stage transcripts failed; the next start retries.",
      "restore.skipped": "A pipeline could not be restored at startup and was skipped.",
      "criteria.record-failed": "Acceptance criteria results could not be recorded on the ticket.",
      "completion-notes.publish-failed":
        "A finished pipeline's notes tab could not be added to the layout; the run stays complete.",
      "workspace.waiting": "A pipeline is waiting for its workspace; written once per reason.",
      "rewind.pending": "A pipeline's code rewind has not finished; written once per reason.",
      "kanban.status-failed":
        "A restarted pipeline's Kanban status could not be set; it retries shortly.",
      "kanban.environment-deleted-read-failed":
        "The pipelines of an environment being deleted could not be read, so their tickets keep their columns.",
      "kanban.environment-deleted-update-failed":
        "The ticket of a pipeline whose environment was deleted could not be moved; the deletion goes on.",
      "usage.read-failed": "Reading a stage session's token usage failed.",
      "checkpoint.deferred":
        "A stage transcript checkpoint could not be written yet; the provider's history stands.",
      "checkpoint.not-committed":
        "A stage transcript checkpoint was reverted in the commit that should have kept it.",
      "worker-mail.claim-failed":
        "Mail queued for a worker could not be claimed at its turn end; it stays queued.",
      "legacy-transcript.deferred":
        "Moving a legacy inline transcript failed; the inline body stays readable.",
    },
  },
});
