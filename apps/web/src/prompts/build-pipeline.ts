/**
 * Prompts for the automated build pipeline: building features,
 * reviewing changes, verifying acceptance criteria, and fixing issues.
 */

import { buildReviewBody } from "./review-shared";

export type TaskSnapshotImage = {
  filename: string;
  /** Base64-encoded image data */
  data: string;
};

export type TaskSnapshot = {
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ text: string }>;
  images: TaskSnapshotImage[];
};

export function createBuildReviewPrompt(task: TaskSnapshot | null, projectNotes: string, targetBranch: string = "main"): string {
  const parts: string[] = [];

  if (task) {
    parts.push("You are reviewing changes for the following ticket:\n");
    parts.push(`**Title**: ${task.title}`);
    if (task.description) parts.push(`\n**Description**: ${task.description}`);
    if (task.acceptanceCriteria) parts.push(`\n**Acceptance Criteria**:\n${task.acceptanceCriteria}`);

    if (task.comments.length > 0) {
      parts.push("\n**Comments**:");
      task.comments.forEach((c, i) => parts.push(`${i + 1}. ${c.text}`));
    }

    if (task.images.length > 0) {
      parts.push(`\n**Attached Images** (${task.images.length}): ${task.images.map((img) => img.filename).join(", ")}`);
      parts.push("These images are included as visual context with this message.");
    }

    parts.push("");
  }

  if (projectNotes) {
    parts.push(`**Project Notes**:\n${projectNotes}\n`);
  }

  parts.push(buildReviewBody({ targetBranch, allowClarifyingQuestions: false }));
  parts.push("");
  parts.push("Begin by running the git commands to understand the current state.");

  return parts.join("\n");
}

export function createBuildPrompt(task: TaskSnapshot | null, projectNotes: string): string {
  if (!task) return "Build the feature as described.";

  const parts = [
    "You are building a feature. Here is the ticket:\n",
    `**Title**: ${task.title}`,
    task.description ? `\n**Description**: ${task.description}` : "",
    task.acceptanceCriteria ? `\n**Acceptance Criteria**:\n${task.acceptanceCriteria}` : "",
  ];

  if (task.comments.length > 0) {
    parts.push("\n**Comments**:");
    task.comments.forEach((c, i) => parts.push(`${i + 1}. ${c.text}`));
  }

  if (task.images.length > 0) {
    parts.push(`\n**Attached Images** (${task.images.length}): ${task.images.map((img) => img.filename).join(", ")}`);
    parts.push("These images are included as visual context with this message. Refer to them when implementing the feature.");
  }

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push("\n\nBuild this feature completely. Do not ask any questions - make your best judgment for any ambiguous requirements. Just go ahead and implement everything needed.");

  return parts.join("\n");
}

export function createAddressIssuesPrompt(): string {
  return `Please address all the above issues and test coverage gaps, without asking questions. Make sensible assumptions. Run typechecking and build validation to ensure the changes are valid as appropriate for the project.

Before finishing:
1. Run \`git status --porcelain\` and \`git diff HEAD\`.
2. Stage only files that clearly belong to the review fixes and test coverage changes you made.
3. Do NOT add secrets, credentials, \`.env*\` files, editor/IDE files, build artifacts, dependency caches (\`node_modules\`, \`target\`, \`dist\`), unrelated changes, or temporary files.
4. Commit the relevant staged changes with a conventional-commit message so they are included in the branch diff used by verification. Do not use \`--no-verify\`.
5. If suspicious, sensitive, generated, or unrelated files remain, leave them uncommitted and report them. Do not modify or delete them merely to make the worktree clean. It is acceptable for \`git status --porcelain\` to remain non-empty solely because of those excluded files.

Do not finish while any relevant review fix or test change remains uncommitted.`;
}

export function createVerificationPrompt(task: TaskSnapshot | null, projectNotes: string, targetBranch: string = "main"): string {
  if (!task) {
    return `Before verification, run \`git status --porcelain\`. Verification is read-only: do not stage, commit, modify, or delete files. If implementation or test changes that belong to the task remain uncommitted, treat verification as incomplete and explain what must be committed. Leave secrets, credentials, \`.env*\` files, generated artifacts, caches, and unrelated changes untouched; they do not require a clean worktree. Then determine whether the committed branch changes satisfy the acceptance criteria.`;
  }

  const parts = [
    "Review the current state of the codebase against the following ticket context:\n",
    `**Title**: ${task.title}`,
    task.description ? `\n**Description**: ${task.description}` : "",
    task.acceptanceCriteria ? `\n**Acceptance Criteria**:\n${task.acceptanceCriteria}` : "",
  ];

  if (task.comments.length > 0) {
    parts.push("\n**Comments**:");
    task.comments.forEach((c, i) => parts.push(`${i + 1}. ${c.text}`));
  }

  if (task.images.length > 0) {
    parts.push(`\n**Attached Images** (${task.images.length}): ${task.images.map((img) => img.filename).join(", ")}`);
    parts.push("These images are included as visual context with this message.");
  }

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push(`\n\nVerify the changes on the current branch against the target branch \`${targetBranch}\`.

1. Run \`git status --porcelain\`. Verification is read-only: do not stage, commit, modify, or delete files. If implementation or test changes that belong to this task remain uncommitted, set \`complete\` to false and explain what must be committed. Leave secrets, credentials, \`.env*\` files, editor/IDE files, generated artifacts, dependency caches, and unrelated changes untouched; they do not require a clean worktree.
2. Run \`git branch --show-current\` to identify the current branch
3. Run \`git diff origin/${targetBranch}...HEAD\` to see all changes since branching from \`${targetBranch}\`
4. Review the diff to determine whether ALL acceptance criteria above are satisfied

Respond with ONLY a JSON object in the following format (no other text before or after):

\`\`\`json
{"complete": true, "rationale": "Your explanation here"}
\`\`\`

Set "complete" to true if ALL acceptance criteria are satisfied, or false if any are not met. In "rationale", provide a detailed explanation of your reasoning.`);

  return parts.join("\n");
}

export function createFixPrompt(task: TaskSnapshot | null, projectNotes: string, feedback: string): string {
  if (!task) return `Fix the following issues:\n\n${feedback}\n\nDo not ask any questions.`;

  const parts = [
    "The following acceptance criteria have NOT been fully satisfied. Here is the ticket context:\n",
    `**Title**: ${task.title}`,
    task.description ? `\n**Description**: ${task.description}` : "",
    task.acceptanceCriteria ? `\n**Acceptance Criteria**:\n${task.acceptanceCriteria}` : "",
  ];

  if (task.comments.length > 0) {
    parts.push("\n**Comments**:");
    task.comments.forEach((c, i) => parts.push(`${i + 1}. ${c.text}`));
  }

  if (task.images.length > 0) {
    parts.push(`\n**Attached Images** (${task.images.length}): ${task.images.map((img) => img.filename).join(", ")}`);
    parts.push("These images are included as visual context with this message.");
  }

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push(`\n\n**Why the acceptance criteria are not satisfied**:\n${feedback}`);
  parts.push("\n\nPlease fix the issues above to satisfy the acceptance criteria. Do not ask any questions - make sensible assumptions and go ahead.");

  return parts.join("\n");
}
