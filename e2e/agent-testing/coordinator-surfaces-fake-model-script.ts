/**
 * The script of the coordinator surfaces fake model
 * (`coordinator-surfaces-fake-model.ts`): what a Pi coordinator on a loopback
 * model does with the scenario's requests (the root-changes dialog and a
 * container worker's browser). Pure, so
 * the rules have unit tests that need no provider.
 *
 * Requests arrive in OpenAI chat-completions form, which Pi uses for a
 * provider declared with `api: "openai-completions"`.
 *
 * - A request line `surfaces-fake: <tool> {json}` in the user's prompt, where
 *   `<tool>` is `request_root_changes` or `open_worker_browser`: one call of
 *   that tool with exactly that JSON as its input, then one line of text. The
 *   spec writes the line, so the arguments (environment, request ID, files,
 *   address) are the spec's, not a model's guess.
 * - A wake (a prompt holding peer-message carriers): one line of text, and
 *   nothing else. What each carrier said is counted (`WakeFacts`), one entry
 *   per carrier, so the spec can prove each root-changes outcome reached the
 *   model exactly once, with its state, even when the mail service batched
 *   several carriers into one prompt.
 * - Anything else: one line of text.
 */
import {
  messageText,
  offeredName,
  offeredTools,
  resultJson,
  type ChatMessage,
} from "./coordinator-routing-fake-model-script";

export type FakeStep =
  { kind: "text"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown> };

export const SURFACE_TOOLS = ["request_root_changes", "open_worker_browser"] as const;
export type SurfaceTool = (typeof SURFACE_TOOLS)[number];

/** Facts about one delivered carrier, counted by the server. Never its text. */
export interface WakeFacts {
  /** The wake is a node action outcome about uncommitted checkout changes. */
  rootChanges: boolean;
  /** The request state the notice names, or `other`. */
  state: "executed" | "rejected" | "failed" | "stale" | "other";
  /** The approval request it is about (`node-action:<id>`), when it says. */
  approvalRequestId?: string;
}

export interface ScriptedTurn {
  step: FakeStep;
  /**
   * One entry per carrier in the wake prompt (the mail service may batch
   * several into one turn). Set on the first request of a wake turn only, so
   * a carrier counts once however many requests its turn makes.
   */
  wakes?: WakeFacts[];
  /** The tool's result, on the request that follows the call. */
  result?: { tool: SurfaceTool; ok: boolean };
}

export const FAKE_REPLY = "Done.";
export const FAKE_ASKED_REPLY = "Asked.";
export const FAKE_WAKE_REPLY = "Noted.";

const CARRIER = "<orkestrator-peer-message";
const CARRIER_CLOSE = "</orkestrator-peer-message>";
const REQUEST = /^surfaces-fake: (request_root_changes|open_worker_browser) (\{.*\})\s*$/m;
const STATE = /Request (executed|rejected|failed|stale)\b/;
const ACTION_ID = /node-action:([A-Za-z0-9_-]{1,200})/;

/** The scripted request in a prompt, or undefined. */
export function parseSurfaceRequest(
  prompt: string,
): { tool: SurfaceTool; input: Record<string, unknown> } | undefined {
  const match = REQUEST.exec(prompt);
  if (!match) return undefined;
  try {
    const input = JSON.parse(match[2]!) as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    return { tool: match[1] as SurfaceTool, input: input as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

export function wakeFacts(prompt: string): WakeFacts {
  const state = STATE.exec(prompt)?.[1] as WakeFacts["state"] | undefined;
  const id = ACTION_ID.exec(prompt)?.[1];
  return {
    rootChanges: prompt.includes("Apply uncommitted checkout changes"),
    state: state ?? "other",
    ...(id ? { approvalRequestId: id } : {}),
  };
}

/**
 * The facts of every carrier in a prompt, in order. A batched delivery joins
 * carriers into one prompt; each is its own notice. The carrier's payload is
 * escaped JSON, so its opening tag cannot appear inside another carrier.
 */
export function carrierWakeFacts(prompt: string): WakeFacts[] {
  return prompt
    .split(CARRIER)
    .slice(1)
    .map((segment) => {
      const end = segment.indexOf(CARRIER_CLOSE);
      return wakeFacts(end < 0 ? segment : segment.slice(0, end));
    });
}

/**
 * Both tools answer success with a JSON object; a refusal or failure comes
 * back as plain text (or an object naming an error).
 */
function resultFailed(text: string): boolean {
  const value = resultJson(text);
  return !value || "error" in value || value.isError === true;
}

/** The next step of a request. */
export function scriptedTurn(request: { messages: unknown; tools?: unknown }): ScriptedTurn {
  const list = Array.isArray(request.messages) ? (request.messages as ChatMessage[]) : [];
  const offered = offeredTools(request.tools);

  let lastUser = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const prompt = messageText(list[lastUser]);
  const results = (lastUser < 0 ? [] : list.slice(lastUser + 1))
    .filter((message) => message?.role === "tool")
    .map(messageText);

  if (prompt.includes(CARRIER)) {
    return {
      step: { kind: "text", text: FAKE_WAKE_REPLY },
      ...(results.length === 0 ? { wakes: carrierWakeFacts(prompt) } : {}),
    };
  }
  const scripted = parseSurfaceRequest(prompt);
  if (!scripted) return { step: { kind: "text", text: FAKE_REPLY } };
  if (results.length === 0) {
    const name = offeredName(offered, scripted.tool);
    return name
      ? { step: { kind: "tool", name, input: scripted.input } }
      : { step: { kind: "text", text: `The ${scripted.tool} tool is not offered.` } };
  }
  return {
    step: { kind: "text", text: FAKE_ASKED_REPLY },
    ...(results.length === 1
      ? { result: { tool: scripted.tool, ok: !resultFailed(results[0]!) } }
      : {}),
  };
}
