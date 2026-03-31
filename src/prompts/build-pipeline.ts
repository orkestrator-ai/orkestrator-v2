/**
 * Prompts for the automated build pipeline: building features,
 * reviewing changes, verifying acceptance criteria, and fixing issues.
 */

export type TaskSnapshot = {
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ text: string }>;
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

    parts.push("");
  }

  if (projectNotes) {
    parts.push(`**Project Notes**:\n${projectNotes}\n`);
  }

  parts.push(`## Step 1: Commit Changes

Based on the current git status and diff, create a single git commit:
1. Run \`git status --porcelain\` and \`git diff HEAD\` to see all changes
2. Add any untracked files that should be committed: \`git add <files>\`
3. Create a commit with a well-formatted message following conventional commit format
4. Do NOT reference Claude or add Claude as a contributor
5. Use this format for the commit message:
   - First line: type(scope): brief description
   - Blank line
   - Bullet points describing the changes

## Step 2: Code Review

Compare the current branch against the remote \`${targetBranch}\` branch and conduct a thorough code review:
1. Run \`git diff origin/${targetBranch}...HEAD\` to see all changes since branching
2. Review the diff focusing on:
   - **Logic and correctness**: Check for bugs, edge cases, and potential issues
   - **Readability**: Is the code clear and maintainable? Does it follow repository patterns?
   - **Performance**: Are there obvious performance concerns or optimizations?
   - **Test coverage**: If the repo has testing patterns, are there adequate tests?
3. Ask clarifying questions if needed about unclear changes

## Output Format

After completing both steps:
1. Confirm the commit was created with its message
2. Provide a summary overview of the general code quality
3. List any identified issues in numbered sections with:
   - Title
   - File and line number(s)
   - Description of the issue
   - Code snippet (if relevant)
   - Potential solution(s)
4. If no issues found, state that the code meets best practices

Begin by running the git commands to understand the current state.`);

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

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push("\n\nBuild this feature completely. Do not ask any questions - make your best judgment for any ambiguous requirements. Just go ahead and implement everything needed.");

  return parts.join("\n");
}

export function createVerificationPrompt(task: TaskSnapshot | null, projectNotes: string): string {
  if (!task) return "Do the changes satisfy the acceptance criteria?";

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

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push(`\n\nDo the changes implemented satisfy ALL acceptance criteria according to the context above?

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

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push(`\n\n**Why the acceptance criteria are not satisfied**:\n${feedback}`);
  parts.push("\n\nPlease fix the issues above to satisfy the acceptance criteria. Do not ask any questions - make sensible assumptions and go ahead.");

  return parts.join("\n");
}
