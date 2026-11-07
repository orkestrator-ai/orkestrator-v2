/**
 * Every `git` command (plan item 7006; docs/reports/unified-federation.md
 * §11.2, Appendix E "Git, GitHub, PR, changes"): the changes ledger
 * (`commands-changes.ts`) and an environment's worktree: diff stats, git
 * status, diff bases and the pipeline's probes (`commands-worktree.ts`).
 *
 * Browser-safe.
 */
import { CHANGES_COMMANDS } from "./commands-changes.js";
import { WORKTREE_GIT_COMMANDS } from "./commands-worktree.js";

export * from "./commands-changes.js";
export * from "./commands-worktree.js";

export const GIT_COMMANDS = [...CHANGES_COMMANDS, ...WORKTREE_GIT_COMMANDS] as const;
