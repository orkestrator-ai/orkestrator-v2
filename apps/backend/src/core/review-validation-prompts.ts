import type { JsonSchema } from "@orkestrator/protocol/structured-output";

export const REVIEW_VALIDATION_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headRef", "commands", "limitations"],
  properties: {
    headRef: { type: "string" },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "command", "cwd", "dependsOn", "resources", "weight", "timeoutMs"],
        properties: {
          id: { type: "string" },
          command: { type: "string" },
          cwd: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          resources: { type: "array", items: { type: "string" } },
          weight: { type: "integer", enum: [1, 2] },
          timeoutMs: { type: "integer" },
        },
      },
    },
    limitations: { type: "array", items: { type: "string" } },
  },
};

export function reviewValidationDiscoveryPrompt(targetBranch: string): string {
  return `Prepare the existing change for review against ${JSON.stringify(targetBranch)}, then discover its validation plan. The backend will run the plan and publish one immutable evidence package to every reviewer.

This is a short command-discovery task. Usually one batched inventory read and one targeted read of task definitions are sufficient. Stop as soon as you know the required entrypoints and their prerequisites. Do not review implementation correctness, read application/test bodies merely to understand the change, inspect full commit history, or repeat repository-wide scans. Read source only when it defines a validation command or is essential to resolve a specific execution dependency. When parallel safety remains uncertain, mark the command exclusive and disclose the uncertainty instead of exhaustively tracing the codebase. Keep all discovery tool output bounded.

1. Inspect the current Git status and changes. Commit only relevant safe changes using the repository's commit conventions and hooks. Never skip hooks, force a clean tree, delete unrelated files, push, merge, rebase, reset, switch branches, or create a worktree. Do not implement features or fix validation failures. If unrelated or sensitive changes prevent a clean worktree, report the limitation.
2. Discover validation requirements afresh from the CURRENT repository: instructions, directory structure, changed paths, CI workflows, manifests, task definitions, toolchain configuration, and relevant scripts. Do not assume a language, package manager, fixed list of files, or that the codebase resembles an earlier review. Follow repository-specific test entrypoints. Do not infer that a command covers another merely from its name.
3. Produce at most 32 commands covering the relevant full tests, static checks, and build, plus any repository-specific requirements. Do not RUN validation, install dependencies, inspect validation output, or perform the code review. Command execution, timing, artifact paths, and exit codes belong to the backend. A skipped requirement needs an explicit limitation; an empty plan requires a limitation.
4. Each command has a unique short id, a non-interactive shell command, a workspace-relative cwd (usually "."), and dependsOn listing prerequisite ids EARLIER in the array. Split independent work so it can run concurrently. Shared build prerequisites run once; avoid overlapping aggregate commands that repeat the same validation. Preserve necessary build/test dependencies and setup/cleanup semantics; tightly coupled setup, test, and cleanup should be one command using a shell trap.
5. resources names directories or shared services the command writes or consumes exclusively (for example a generated output directory, test database, or simulator). Commands with the same resource serialize. Use ["*"] if interference is uncertain. Empty resources means you have verified parallel safety. weight=2 reserves the runner for internally parallel or memory-heavy work; weight=1 allows two independent commands concurrently. Do not guess a command is lightweight. timeoutMs must be between 1000 and 7200000 and appropriate to this project. Never request watch mode, interactive input, background servers without cleanup, or a detached process.
6. Read the final full HEAD commit SHA into headRef. Commands will run only while this clean snapshot still matches. Include actual missing prerequisites and coverage uncertainty in limitations. Do not include secrets or environment-variable values in the plan.

Keep discovery focused on what must run and how it can overlap safely. Narrate concise ordinary-prose progress; only the final response is the schema-constrained plan. Do not return command results or read old validation artifacts.`;
}

export const IMPLEMENTATION_VALIDATION_HANDOFF =
  "Commit every relevant implementation and test change without bypassing hooks. Run focused checks needed during implementation. The next preparation stage discovers and executes final full validation once against the committed snapshot; do not run a separate full test/typecheck/build pass or prepare validation artifacts here.";
