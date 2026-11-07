/**
 * Every `pull-requests` command (plan item 7006; docs/reports/
 * unified-federation.md §11.2, Appendix E "Git, GitHub, PR, changes"): the
 * GitHub API surface, issues and the pull request viewer
 * (`commands-github.ts`), and an environment's pull request
 * (`commands-environment.ts`).
 *
 * GitHub issues are in this domain because `DOMAIN_NAMES` has no `github`
 * domain and the issues share the GitHub credential, the error sanitising
 * and the review flow with pull requests (plan item 1006's mapping,
 * confirmed by 7006).
 *
 * Browser-safe.
 */
import { ENVIRONMENT_PR_COMMANDS } from "./commands-environment.js";
import { GITHUB_ISSUE_COMMANDS, GITHUB_PULL_REQUEST_COMMANDS } from "./commands-github.js";

export * from "./commands-github.js";
export * from "./commands-environment.js";

export const PULL_REQUESTS_COMMANDS = [
  ...GITHUB_ISSUE_COMMANDS,
  ...GITHUB_PULL_REQUEST_COMMANDS,
  ...ENVIRONMENT_PR_COMMANDS,
] as const;
