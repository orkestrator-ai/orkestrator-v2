/**
 * Prompts for the automated build pipeline: building features,
 * reviewing changes, verifying acceptance criteria, and fixing issues.
 */

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

## Step 2: Run Tests

Run the project's full test suite to ensure nothing is broken:
1. Identify the project's test runner (check package.json scripts, Makefile, etc.)
2. Run the full test suite
3. If any tests fail, record every failure with the test name, file, and error message

## Step 3: Code Review

Compare the current branch against the remote \`${targetBranch}\` branch and conduct a thorough code review:
1. Run \`git diff origin/${targetBranch}...HEAD\` to see all changes since branching
2. Review the diff focusing on:
   - **Logic and correctness**: Check for bugs, edge cases, and potential issues
   - **Readability**: Is the code clear and maintainable? Does it follow repository patterns?
   - **Performance**: Are there obvious performance concerns or optimizations?
   - **Security**: Are there any security vulnerabilities or potential security issues? Has the change weakened security in any way?
3. Do not ask clarifying questions about unclear changes as this is an automated pipeline. Make your best judgment for any ambiguous points.
4. Run typechecking and build validation to ensure the changes are valid as appropriate for the project.

## Step 4: Test Coverage Review

Review test coverage for every file impacted by the changes (not just the changed lines):
1. From the diff in Step 3, identify all files that were added or modified
2. For each impacted file, find its corresponding test file(s)
3. If an impacted file has no test file, flag it as lacking test coverage
4. For each impacted file that does have tests, review the **entire file** (not just the changed code) and verify:
   - All public functions and methods have test coverage
   - Edge cases and error paths are tested
   - Any complex logic branches are covered
5. List any gaps in test coverage, including for code that was not modified in this change

## Output Format

After completing all steps:
1. Confirm the commit was created with its message
2. Report test suite results: total tests run, passed, and failed. List every failing test with details.
3. Provide a summary overview of the general code quality
4. List any identified code review issues in numbered sections with:
   - Title
   - File and line number(s)
   - Description of the issue
   - Code snippet (if relevant)
   - Potential solution(s)
5. List any test coverage gaps found in impacted files, including untested code that was not part of this change
6. If no issues found, state that the code meets best practices and has adequate test coverage

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

export function createVerificationPrompt(task: TaskSnapshot | null, projectNotes: string, targetBranch: string = "main"): string {
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

  if (task.images.length > 0) {
    parts.push(`\n**Attached Images** (${task.images.length}): ${task.images.map((img) => img.filename).join(", ")}`);
    parts.push("These images are included as visual context with this message.");
  }

  if (projectNotes) {
    parts.push(`\n**Project Notes**:\n${projectNotes}`);
  }

  parts.push(`\n\nVerify the changes on the current branch against the target branch \`${targetBranch}\`.

1. Run \`git branch --show-current\` to identify the current branch
2. Run \`git diff origin/${targetBranch}...HEAD\` to see all changes since branching from \`${targetBranch}\`
3. Review the diff to determine whether ALL acceptance criteria above are satisfied

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
