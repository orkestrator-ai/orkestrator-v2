/**
 * Prompts for git-related workflows: PR creation, code review,
 * pushing changes, and merge-conflict resolution.
 */

import { createPRPrompt } from "@orkestrator/protocol/pr-prompt";
import {
  buildReviewBody,
  DEFAULT_REVIEW_INSTRUCTION,
  REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN,
} from "./review-shared";

/** @deprecated Use REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN. */
export const REVIEW_PROMPT_TARGET_BRANCH_TOKEN = REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN;

export { createPRPrompt };

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

Resolve any remaining conflicts, then validate the merged result even on resume after staging or committing:
1. Run \`git status\` to see which files have conflicts. Before staging any resolution, capture the complete original unmerged path list with git diff --name-only --diff-filter=U -z and retain it in local Git metadata, outside tracked files, for resume, tied to this merge's parent commit IDs. Keep every original conflict in scope even if its resolution exactly matches either parent, including after staging or committing.
2. For each conflicted file:
   - Read the file to understand the conflict markers (<<<<<<<, =======, >>>>>>>)
   - Analyze both versions and determine the correct resolution
   - Edit the file to resolve the conflict, removing all conflict markers
   - Ensure the resolved code is correct and functional
3. After resolving all conflicts, run \`git add -A\` to stage the resolved files
4. Validate the resolution:
   - Always run repository-required checks before pushing; repository instructions take precedence over targeted validation and prose-only skipping.
   - Assess the whole merge delta from the merge parents' common ancestor to the merged result, including cleanly auto-merged changes and conflict resolutions. Validation on separate branches does not establish that the combined merge is validated.
   - Only if the complete original conflict list is known, every original conflicted file and the whole merge delta are prose documentation not consumed by tests, builds, or tooling, and repository instructions permit skipping, may you skip tests, typechecking, or builds; confirm no conflict markers remain and run applicable documentation checks such as formatting or link checks.
   - If any original conflict or any part of the whole merge delta is source, configuration, a test, or Markdown consumed by tests, builds, or tooling, run relevant validation on the merged result, targeted at affected files and their dependents. Auto-merged code alongside prose-only conflicts still requires relevant tests or typechecking. Run the full suite when impact cannot be scoped or repository instructions require it.
   - File role takes precedence over location or extension: source files under docs/ (such as .ts or .mdx) count as code, not documentation.
   - On resume, use the complete retained original conflict list. Once staging has begun, the remaining live unmerged paths are not a complete original list; never overwrite the retained list with them. Staged paths differing from both parents and a merge commit's combined diff cannot reconstruct that list: they can omit conflicts resolved to one parent and include clean auto-merges. If the original list is unavailable or incomplete, or the whole merge delta cannot be established, treat scope as unknown: do not apply the prose-only skip; run relevant validation on the merged result, or conservative full validation when impact cannot be scoped.

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
