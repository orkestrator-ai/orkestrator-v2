import { defineLogAreas } from "./define.js";

export const GIT_LOG_AREAS = defineLogAreas({
  git: {
    description: "Git operations the backend runs in environment worktrees and containers.",
    events: {
      "branch.rename-failed": "Renaming an environment's branch failed; the stored name is kept.",
      "branch.push-config-failed":
        "A branch was renamed but its push settings could not be written; the rename is undone.",
      "branch.rollback-failed":
        "Undoing a branch rename failed; the stored name follows whichever branch now exists.",
    },
  },
});
