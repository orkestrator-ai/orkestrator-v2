/**
 * Prompts for git-related workflows: PR creation, code review,
 * pushing changes, and merge-conflict resolution.
 */

import { buildReviewBody } from "./review-shared";
import { getReviewPromptValidationError } from "@orkestrator/protocol/review-prompt";

/** Token available in custom action-bar review prompt templates. */
export const REVIEW_PROMPT_TARGET_BRANCH_TOKEN = "{{targetBranch}}";

/**
 * Generates the prompt for the PR creation workflow.
 * This prompt instructs Claude to commit all changes, push, and create a PR.
 *
 * Used by both the manual "Create PR" action bar button and the
 * automated build pipeline PR creation session.
 */
export function createPRPrompt(targetBranch: string): string {
  return `You are performing a complete PR creation workflow. Execute these steps in order:

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

Push the current branch to the remote:
1. Run \`git branch --show-current\` to get the current branch name
2. Push with: \`git push -u origin <branch-name>\`
3. If the push fails due to upstream changes, handle appropriately (pull --rebase if needed, then push again)

## Step 4: Create Pull Request

Create a PR against the \`${targetBranch}\` branch:
1. Run \`git diff origin/${targetBranch}...HEAD\` to see all changes that will be in the PR
2. Run \`git log ${targetBranch}..HEAD --oneline\` to see all commits
3. Create the PR using: \`gh pr create --base ${targetBranch} --fill\`
   - If --fill doesn't provide enough context, use --title and --body with a detailed description
4. The PR description should:
   - Summarize the key changes and their purpose
   - List the main features or fixes included
   - Note any breaking changes or migration steps if applicable

## Output

After completing all steps:
1. Confirm each step completed successfully
2. Provide the PR URL at the end so the user can review it

Begin by running git status to understand the current state.`;
}

/**
 * Generates the prompt for the code review workflow.
 * This prompt instructs the agent to commit changes and perform a code review.
 * Shares its body with `createBuildReviewPrompt` via `buildReviewBody()`.
 */
function createDefaultReviewPrompt(targetBranch: string): string {
  return [
    "You are performing a commit and code review workflow. Execute the steps in order.",
    "",
    buildReviewBody({ targetBranch, allowClarifyingQuestions: true }),
    "",
    "If issues are found and the user asks to fix them, run typechecking and build validation again as appropriate for the project.",
    "",
    "Begin by running the git commands to understand the current state.",
  ].join("\n");
}

/** Built-in action-bar review prompt, kept as a template for the settings editor. */
export const DEFAULT_REVIEW_PROMPT_TEMPLATE = createDefaultReviewPrompt(
  REVIEW_PROMPT_TARGET_BRANCH_TOKEN,
);

/**
 * Generates the action-bar code review prompt.
 *
 * A saved custom template replaces the built-in workflow. Both templates may
 * use `{{targetBranch}}`, which is resolved when a review tab is created.
 */
export function createReviewPrompt(targetBranch: string, customPrompt?: unknown): string {
  const template = typeof customPrompt === "string"
    && getReviewPromptValidationError(customPrompt) === null
    ? customPrompt
    : DEFAULT_REVIEW_PROMPT_TEMPLATE;

  return template.replaceAll(
    REVIEW_PROMPT_TARGET_BRANCH_TOKEN,
    () => targetBranch,
  );
}

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

/**
 * Generates the prompt for resolving merge conflicts with the target branch.
 * This prompt instructs Claude to fetch, merge, resolve conflicts, and push.
 */
export function createResolveConflictsPrompt(targetBranch: string): string {
  return `Resolve any merge conflicts with the target remote branch (${targetBranch}). Subsequently, commit and push all changes.

Execute these steps in order:

## Step 1: Fetch Latest Changes

1. Run \`git fetch origin\` to get the latest changes from remote
2. Run \`git status\` to understand the current state

## Step 2: Merge Target Branch

1. Run \`git merge origin/${targetBranch}\` to merge the target branch
2. If there are conflicts, they will be shown in the output

## Step 3: Resolve Conflicts

If there are merge conflicts:
1. Run \`git status\` to see which files have conflicts
2. For each conflicted file:
   - Read the file to understand the conflict markers (<<<<<<<, =======, >>>>>>>)
   - Analyze both versions and determine the correct resolution
   - Edit the file to resolve the conflict, removing all conflict markers
   - Ensure the resolved code is correct and functional
3. After resolving all conflicts, run \`git add -A\` to stage the resolved files

## Step 4: Complete the Merge

1. Create a merge commit with: \`git commit -m "Merge ${targetBranch} and resolve conflicts"\`
2. Do NOT use --no-verify or skip any hooks

## Step 5: Push Changes

1. Push the resolved changes: \`git push\`
2. If the push fails, handle appropriately

## Output

After completing all steps:
1. Summarize which files had conflicts and how they were resolved
2. Confirm the merge commit was created
3. Confirm the changes were pushed successfully

Begin by fetching the latest changes.`;
}
