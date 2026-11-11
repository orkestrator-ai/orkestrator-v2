import { defineLogAreas } from "./define.js";

export const WEB_KANBAN_LOG_AREAS = defineLogAreas({
  "web.kanban": {
    description: "The Kanban board, its task dialog and project notes.",
    events: {
      "tasks.load-failed": "A project's tasks could not be loaded.",
      "task.add-failed": "A new task could not be added.",
      "task.update-failed": "A task's fields could not be updated.",
      "task.content-update-failed": "A task's content edit could not be saved.",
      "task.build-status-clear-failed": "A task's build status could not be cleared.",
      "task.delete-failed": "A task could not be deleted.",
      "task.move-failed": "A task move failed and its status was rolled back.",
      "comment.add-failed": "A comment could not be added to a task.",
      "comment.delete-failed": "A comment could not be deleted from a task.",
      "pr.merge-failed":
        "Merging a ticket's pull request from its Notes tab failed; the error was shown to the user.",
      "image.add-failed": "An image could not be added to a task.",
      "image.delete-failed": "An image could not be deleted from a task.",
      "notes.load-failed": "Project notes could not be loaded; the editor stays disabled.",
      "notes.save-failed": "Project notes could not be saved.",
      "notes.draft-retained": "A notes save failed; the edit stays in its durable draft.",
      "draft.restore-failed": "A saved create-task draft could not be restored.",
      "draft.persist-failed": "A create-task draft could not be saved; phase says when.",
      "draft.discard-failed": "A create-task draft could not be removed; phase says when.",
      "build.start-failed": "The task dialog could not start a build for a task.",
      "build.create-and-start-failed": "The task dialog could not create a task and build it.",
    },
  },
  "web.feature-plan": {
    description: "Feature planning in the renderer.",
    events: {
      "features.load-failed": "A project's features could not be loaded.",
      "feature.create-failed": "A new feature could not be created.",
      "feature.update-failed": "A feature could not be updated.",
      "build.claim-failed": "A feature's build could not be claimed for a task.",
      "build.start-failed": "Starting a build from a feature failed.",
      "message.append-failed": "A message could not be added to a feature's chat.",
      "story-message.append-failed": "A message could not be added to a story's chat.",
      "planning.start-failed": "Feature planning could not be started.",
      "planning.retry-failed": "Feature planning could not be retried.",
      "planning.cancel-failed": "Feature planning could not be cancelled.",
      "drafts.persist-failed": "A project's feature chat drafts could not be saved.",
      "drafts.restore-failed": "A project's feature chat drafts could not be restored.",
    },
  },
});
