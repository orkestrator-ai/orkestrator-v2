/**
 * The single-agent Review, Push Changes and generic "Address all" prompts,
 * shared by the renderer's action bar and the backend's `review.start` and
 * `pr.push` public actions, so every client launches exactly the same workflow.
 *
 * The PR creation and conflict-resolution prompts live in `pr-prompt.ts`.
 */

import {
  MULTI_REVIEW_ADDRESS_USER_INSTRUCTION,
  MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION,
} from "./multi-review.js";
import { wrapSystemInstructions } from "./review-evidence-frames.js";
import { buildReviewBody, REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN } from "./review-workflow.js";

/** @deprecated Use REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN. */
export const REVIEW_PROMPT_TARGET_BRANCH_TOKEN = REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN;

/**
 * Generates the action-bar code review prompt.
 *
 * Instructs the agent to fix the review snapshot and perform a code review.
 * Shares its body with the other interactive review workflows through
 * `buildReviewBody()`. A saved instruction is embedded inside the built-in
 * safety, workflow and output framing; it may use `{{targetBranch}}`, which is
 * resolved here.
 */
export function createReviewPrompt(targetBranch: string, reviewInstruction?: unknown): string {
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
export const DEFAULT_REVIEW_PROMPT_TEMPLATE = createReviewPrompt(REVIEW_PROMPT_TARGET_BRANCH_TOKEN);

/** The single-agent Review tab's title, shared by the button and `review.start`. */
export const REVIEW_TAB_TITLE = "Review";

/** The Push Changes tab's title, shared by the button and `pr.push`. */
export const PUSH_CHANGES_TAB_TITLE = "Git Push";

/**
 * The "Address all" follow-up on a single-agent review tab. Generic review
 * tabs do not inherit Multi Review's automated prompt contracts, only its
 * address instruction and implementation-mode framing.
 */
export const ADDRESS_ALL_REVIEW_PROMPT = `${MULTI_REVIEW_ADDRESS_USER_INSTRUCTION}\n\n${wrapSystemInstructions(MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION)}`;

/**
 * The base branch a PR-relative action works against when the caller named
 * none: the repository's configured PR base branch, else `main`. Falsy rather
 * than nullish, because repository settings persist a cleared base as `""`,
 * and an empty base would reach the agent as `gh pr create --base `.
 */
export function defaultPrTargetBranch(repositoryPrBaseBranch: string | null | undefined): string {
  return repositoryPrBaseBranch?.trim() || "main";
}

/**
 * Generates the prompt for pushing changes to an existing PR.
 * This prompt instructs the agent to commit all changes and push to the current branch.
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
