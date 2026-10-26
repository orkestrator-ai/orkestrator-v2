/**
 * Prompts for git-related workflows: PR creation, code review,
 * pushing changes, and merge-conflict resolution.
 */

import { createPRPrompt, createResolveConflictsPrompt } from "@orkestrator/protocol/pr-prompt";
import {
  buildReviewBody,
  DEFAULT_REVIEW_INSTRUCTION,
  REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN,
} from "./review-shared";

/** @deprecated Use REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN. */
export const REVIEW_PROMPT_TARGET_BRANCH_TOKEN = REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN;

export { createPRPrompt, createResolveConflictsPrompt };

/**
 * Generates the prompt for the code review workflow.
 * This prompt instructs the agent to commit changes and perform a code review.
 * Shares its body with the other interactive review workflows via
 * `buildReviewBody()`.
 */
function createDefaultReviewPrompt(targetBranch: string, reviewInstruction?: unknown): string {
  return [
    "You are performing a commit and code review workflow. Fix the review snapshot first, then overlap independent validation and analysis where supported.",
    "",
    "If issues are found and the user asks to fix them, run typechecking and build validation again as appropriate for the project.",
    "",
    "Begin by running the git commands required to establish the review snapshot.",
    "",
    buildReviewBody({
      targetBranch,
      reviewInstruction,
      allowClarifyingQuestions: true,
      outputFormat: "markdown",
    }),
  ].join("\n");
}

/** Complete built-in prompt retained as a compatibility/exported inspection value. */
export const DEFAULT_REVIEW_PROMPT_TEMPLATE = createDefaultReviewPrompt(
  REVIEW_PROMPT_TARGET_BRANCH_TOKEN,
);

/**
 * Generates the action-bar code review prompt.
 *
 * A saved instruction is embedded inside the built-in safety, workflow, and
 * output framing. It may use `{{targetBranch}}`, which is resolved when a
 * review tab is created.
 */
export function createReviewPrompt(targetBranch: string, reviewInstruction?: unknown): string {
  return createDefaultReviewPrompt(targetBranch, reviewInstruction);
}

export { DEFAULT_REVIEW_INSTRUCTION, REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN };

/**
 * Generates the prompt for pushing changes to an existing PR.
 * This prompt instructs Claude to commit all changes and push to the current branch.
 */
export function createPushChangesPrompt(): string {
  return `You are performing a commit and push workflow to update an existing PR. Execute these steps in order:

## Step 1: Stage All Changes

Add all files (including untracked files) to staging:
1. Run \`git status --porcelain\` to see all changes and untracked files
2. Run \`git add -A\` to stage ALL changes including untracked files
3. Verify with \`git status\` that everything is staged

## Step 2: Create Commit

Create a well-formatted commit with all staged changes:
1. Run \`git diff --cached\` to review what will be committed
2. Create a commit with a well-formatted message following conventional commit format:
   - First line: type(scope): brief description
   - Blank line
   - Bullet points describing the key changes
3. Do NOT reference Claude or add Claude as a contributor
4. Do NOT use --no-verify or skip any hooks

## Step 3: Push to Remote

Push the current branch to update the PR:
1. Run \`git branch --show-current\` to get the current branch name
2. Push with: \`git push\`
3. If the push fails due to upstream changes, handle appropriately (pull --rebase if needed, then push again)

## Output

After completing all steps:
1. Confirm each step completed successfully
2. Note that the PR has been updated with the new changes

Begin by running git status to understand the current state.`;
}
