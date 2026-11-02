import { defineLogAreas } from "./define.js";

export const WEB_GITHUB_LOG_AREAS = defineLogAreas({
  "web.github": {
    description: "Pull request and GitHub issue views.",
    events: {
      "pull-request.url-failed": "A pull request's URL could not be read.",
      "pull-request.mode-request-failed": "The pull request monitor refused a watch mode request.",
      "pull-request.copy-failed": "A pull request value could not be copied to the clipboard.",
      "comment-edit-draft.clear-failed": "An edited comment's saved draft could not be cleared.",
      "issue-draft.clear-failed": "An edited issue's saved drafts could not be cleared.",
      "comment-draft.clear-failed": "A posted comment's draft could not be cleared.",
    },
  },
  "web.linear": {
    description: "The Linear tickets view.",
    events: {
      "comment-draft.clear-failed": "A posted comment's draft could not be cleared.",
    },
  },
});
