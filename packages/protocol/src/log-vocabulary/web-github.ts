import { defineLogAreas } from "./define.js";

export const WEB_GITHUB_LOG_AREAS = defineLogAreas({
  "web.github": {
    description: "Pull request and GitHub issue views.",
    events: {
      "pull-request.url-failed": "A pull request's URL could not be read.",
    },
  },
  "web.linear": {
    description: "The Linear tickets view.",
    events: {
      "comment-draft.clear-failed": "A posted comment's draft could not be cleared.",
    },
  },
});
