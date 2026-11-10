/**
 * The script of the Auto-pipeline fake model (`auto-pipeline-fake-model.ts`,
 * to-do 7547 task 4): what a compliant model does with each request the
 * Auto-pipeline flow sends, from the interactive source tab's first turn
 * through drafting, package preparation, review and Verify. Pure, so the
 * rules have unit tests that need no provider.
 *
 * Requests arrive in OpenAI chat-completions form, which Pi uses for a
 * provider declared with `api: "openai-completions"`. The fake never judges
 * code: every result is fixed, valid and finding-free. That is the point of a
 * fake-model run (it proves the product's plumbing, not a model's review) and
 * also its limit.
 */
import { FAKE_WORKFLOW_RESULTS } from "../../scripts/recurring-live-ab-fake-model";

export type ChatMessage = { role?: unknown; content?: unknown };

export type FakeStep =
  { kind: "text"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown> };

/** The text of every reply that is not a tool call. */
export const FAKE_REPLY = "Done.";

/** Pi's shell tool. */
export const SHELL_TOOL = "bash";

/**
 * `[write:<relative path>]` in a prompt asks the fake to create that file with
 * one shell call, so the source tab's transcript holds the work it drafted
 * from. The path is a short fixture-relative name; nothing else is accepted.
 */
const WRITE_MARKER = /\[write:([A-Za-z0-9][A-Za-z0-9._/-]{0,119})\]/;

/** The fixed file content the write marker produces. */
export const FIXTURE_FILE_TEXT = "Auto-pipeline fake-model fixture";

const RESULT_KEY = /resultKey "?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/g;
const CAPABILITY = /capability "([^"\s]{1,512})"/g;
const SUBMIT_TOOL = /call the Orkestrator `(submit_[a-z_]+)` tool/g;
const CRITERIA_BLOCK = /<acceptance-criteria-json>\s*([\s\S]*?)\s*<\/acceptance-criteria-json>/g;

/** The ticket the drafting turn submits: valid, two checkable criteria. */
export const FAKE_DRAFT_TITLE = "Record the Auto-pipeline fixture note";
export const FAKE_DRAFT = {
  title: FAKE_DRAFT_TITLE,
  description: [
    "## Summary",
    "Adds a fixture note written by the interactive tab.",
    "",
    "## Problem",
    "The fixture project has no note recording the Auto-pipeline qualification run.",
    "",
    "## Context",
    "A scripted fake model wrote this draft from the tab transcript and branch diff.",
  ].join("\n"),
  acceptanceCriteria: [
    "The fixture note file exists in the worktree.",
    "The fixture note is committed on the environment branch.",
  ],
  notes: {
    summary: "The interactive tab wrote one fixture note file.",
    workDone: ["Created the fixture note with one shell command."],
    decisions: [],
    tests: [
      {
        name: "test -f on the fixture note",
        result: "not-run",
        details: "A scripted fake model ran no checks.",
      },
    ],
    notDone: [],
  },
};

const FIX_RESULT = {
  complete: true,
  summary: "No findings to address.",
  filesChanged: [],
  commandsRun: [],
  notes: [],
  limitations: ["A scripted fake model changed nothing."],
};

/** Every result the fake submits, by submission tool. Verify's is built per request. */
export const FAKE_RESULTS: Readonly<Record<string, unknown>> = {
  ...FAKE_WORKFLOW_RESULTS,
  submit_auto_pipeline_draft: FAKE_DRAFT,
  submit_fix_result: FIX_RESULT,
};

export const VERIFY_TOOL = "submit_verification_result";
export const VALIDATION_PLAN_TOOL = "submit_validation_plan";

export function messageText(message: ChatMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

function lastMatch(pattern: RegExp, text: string): string | undefined {
  let found: string | undefined;
  for (const match of text.matchAll(pattern)) found = match[1];
  return found;
}

/** The tool name the runtime offers for `tool`: bare, or namespaced by an MCP server. */
export function offeredName(offered: readonly string[], tool: string): string | undefined {
  return (
    offered.find((name) => name === tool) ??
    offered.find((name) => name.endsWith(`__${tool}`) || name.endsWith(`_orkestrator_${tool}`))
  );
}

export function offeredTools(tools: unknown): string[] {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => (tool as { function?: { name?: unknown } } | null)?.function?.name)
    .filter((name): name is string => typeof name === "string");
}

/** Verify's per-criterion verdicts, every listed criterion passed. */
export function verificationResult(prompt: string): Record<string, unknown> {
  let ids: string[] = [];
  const block = lastMatch(CRITERIA_BLOCK, prompt);
  if (block) {
    try {
      const parsed = JSON.parse(block) as unknown;
      if (Array.isArray(parsed))
        ids = parsed
          .map((entry) => (entry as { id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === "string");
    } catch {
      ids = [];
    }
  }
  return {
    complete: true,
    rationale: "A scripted fake model accepted the committed change.",
    acceptanceCriteria: ids.map((id) => ({
      id,
      status: "passed",
      evidence: "Scripted fake-model verdict for the qualification run.",
    })),
  };
}

export interface ScriptedRequest {
  /** The request's messages, in OpenAI chat-completions form. */
  messages: unknown;
  tools?: unknown;
}

export interface ScriptedTurn {
  step: FakeStep;
  /** The workflow result tool this turn is working on, if any (never its arguments). */
  workflow?: string;
  /** Whether this step is the workflow submission itself. */
  submits?: boolean;
}

/**
 * The next step of a turn. A workflow turn names its submission tool and
 * result key in its instruction; the fake reads HEAD first when the result
 * needs it, then submits once, then replies. Anything else is a plain reply,
 * or one shell write for a `[write:…]` prompt.
 */
export function scriptedTurn(request: ScriptedRequest): ScriptedTurn {
  const list = Array.isArray(request.messages) ? (request.messages as ChatMessage[]) : [];
  let lastUser = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const prompt = messageText(list[lastUser]);
  const after = lastUser < 0 ? [] : list.slice(lastUser + 1);
  const toolResults = after.filter((message) => message?.role === "tool");
  const offered = offeredTools(request.tools);
  // The result-tool instruction travels with the prompt; a runtime that moves
  // it into a system message still names the same tool and key there.
  const instructions = lastMatch(SUBMIT_TOOL, prompt)
    ? prompt
    : list
        .slice(0, lastUser + 1)
        .filter((message) => message?.role === "system" || message?.role === "user")
        .map(messageText)
        .join("\n");
  const wanted = lastMatch(SUBMIT_TOOL, instructions);
  const resultKey = lastMatch(RESULT_KEY, instructions);
  if (wanted && resultKey) {
    const name = offeredName(offered, wanted);
    if (!name)
      return {
        step: { kind: "text", text: `The ${wanted} tool is not offered.` },
        workflow: wanted,
      };
    const readsHead = wanted === VALIDATION_PLAN_TOOL ? 1 : 0;
    if (toolResults.length < readsHead)
      return {
        step: { kind: "tool", name: SHELL_TOOL, input: { command: "git rev-parse HEAD" } },
        workflow: wanted,
      };
    if (toolResults.length > readsHead)
      return { step: { kind: "text", text: FAKE_REPLY }, workflow: wanted };
    const capability = lastMatch(CAPABILITY, instructions);
    let result: unknown = FAKE_RESULTS[wanted];
    if (wanted === VERIFY_TOOL) result = verificationResult(`${instructions}\n${prompt}`);
    if (wanted === VALIDATION_PLAN_TOOL) {
      const sha = toolResults
        .map((message) => /\b[0-9a-f]{40}\b/.exec(messageText(message))?.[0])
        .find(Boolean);
      result = { ...(result as object), headRef: sha ?? "" };
    }
    if (result === undefined)
      return { step: { kind: "text", text: `No scripted ${wanted} result.` }, workflow: wanted };
    return {
      step: {
        kind: "tool",
        name,
        input: { resultKey, ...(capability ? { capability } : {}), result },
      },
      workflow: wanted,
      submits: true,
    };
  }
  const write = WRITE_MARKER.exec(prompt)?.[1];
  if (write && !write.split("/").includes("..") && toolResults.length === 0) {
    const directory = write.includes("/") ? write.slice(0, write.lastIndexOf("/")) : "";
    return {
      step: {
        kind: "tool",
        name: SHELL_TOOL,
        input: {
          command: `${directory ? `mkdir -p '${directory}' && ` : ""}printf '%s\\n' '${FIXTURE_FILE_TEXT}' > '${write}'`,
        },
      },
    };
  }
  return { step: { kind: "text", text: FAKE_REPLY } };
}
