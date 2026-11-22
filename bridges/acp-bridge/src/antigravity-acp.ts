/**
 * Google Antigravity (`agy acp`) specifics, kept out of the shared ACP code.
 *
 * Everything here is keyed by provider id and observed on the pinned 1.5.12
 * binary (`initialize` answered with a throwaway `HOME`, 2026-11-22) or in
 * T3 Code's Antigravity adapter (pingdotgg/t3code@bc13afa, cited per item).
 * Standard ACP behaviour stays in the shared modules; only a quirk belongs
 * here. See docs/architecture/agent-engines.md, "Antigravity".
 */
// Local copies rather than imports: `acp-context.ts` imports this module.
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/**
 * How long `authenticate` may take when the backend names a method
 * (`ORKESTRATOR_ANTIGRAVITY_AUTH_METHOD`: an API key or Agent Platform login).
 *
 * The bridge never calls `authenticate` for the Google login. With no login,
 * agy 1.5.12 does not fail it: it starts an interactive browser sign-in and
 * waits (it answered `-32800 Sign-in was cancelled` only when stdin closed,
 * and `-32603 No browser is available` on a machine without a display). A
 * session request without a login fails at once with `-32000 Authentication
 * required` instead, which is what reports sign-in required. The login itself
 * is the one `agy acp --login` stores on the machine.
 */
export const ANTIGRAVITY_AUTHENTICATE_TIMEOUT_MS = 20_000;

export const ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE =
  "Antigravity isn't signed in on this machine. Sign in with agy acp --login in a terminal, then try again.";

export const ANTIGRAVITY_SIGN_IN_HINT = "Open a terminal and run agy acp --login.";

/**
 * Whether an `authenticate` failure means "nobody is signed in" rather than a
 * transport fault. agy answers `-32000 Authentication required` to a session
 * request without a login and `-32800 Sign-in was cancelled` to an abandoned
 * interactive sign-in (both observed on 1.5.12).
 */
export function isAntigravitySignInFailure(error: unknown): boolean {
  const code = isObject(error) && typeof error.code === "number" ? error.code : undefined;
  const message = error instanceof Error ? error.message : isObject(error) ? error.message : "";
  if (code === -32800) return true;
  // `-32603 No browser is available here ... Run \`agy acp --login\`` is the
  // answer to `authenticate` on a machine without a display (1.5.12).
  return (
    typeof message === "string" &&
    /authentication required|sign-?in was cancel|agy acp --login/i.test(message)
  );
}

/**
 * Whether `initialize` offers Antigravity's own session-instruction carrier,
 * `agentCapabilities._meta.antigravity.systemPrompt.append` (true on 1.5.12;
 * the standard `sessionCapabilities.systemPrompt` is not advertised).
 */
export function antigravityAppendsSystemPrompt(initialized: JsonObject): boolean {
  const capabilities = isObject(initialized.agentCapabilities)
    ? initialized.agentCapabilities
    : undefined;
  const meta = isObject(capabilities?._meta) ? capabilities._meta : undefined;
  const antigravity = isObject(meta?.antigravity) ? meta.antigravity : undefined;
  const systemPrompt = isObject(antigravity?.systemPrompt) ? antigravity.systemPrompt : undefined;
  return systemPrompt?.append === true;
}

/** The `_meta` a session request carries the instructions in (T3 `AntigravityAcpSupport.ts`). */
export function antigravitySystemPromptMeta(instructions: string): JsonObject {
  return { antigravity: { systemPrompt: { append: instructions } } };
}

/**
 * The line agy prints on stdout, outside JSON-RPC, when it starts an
 * interactive sign-in (T3 `antigravityAuthSupport.ts`). The bridge treats it
 * as "sign-in required" instead of a malformed frame, and never records or
 * logs the line: it carries a sign-in link.
 */
export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  "Open the following link to authenticate the ACP server: ";

export function isAntigravityLoginBanner(line: string): boolean {
  return line.trimStart().startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX);
}

/** One fixed-choice question agy sends as a permission request. */
export interface AntigravityQuestion {
  question: string;
  options: Array<{ id: string; label: string }>;
}

const QUESTION_PREFIX = "interaction_";
const MAX_QUESTION_TEXT = 4_096;
const MAX_OPTION_LABEL = 512;
const MAX_OPTION_ID = 512;
const MAX_OPTIONS = 32;

/**
 * Whether a `session/request_permission` is a human question, not an approval.
 *
 * agy sends its fixed-choice questions through the permission method with a
 * tool-call id beginning `interaction_` (T3 `AntigravityProtocol.ts`). They
 * must be recognised before any approval policy runs: an auto-approving
 * session would otherwise pick an answer for the person.
 */
export function isAntigravityQuestionRequest(params: JsonObject): boolean {
  const toolCall = isObject(params.toolCall) ? params.toolCall : undefined;
  return (
    typeof toolCall?.toolCallId === "string" && toolCall.toolCallId.startsWith(QUESTION_PREFIX)
  );
}

/**
 * The question in a question-shaped permission request, or `undefined` when
 * it is malformed: no options, a blank or duplicate option id, or more
 * options than a card can show. A malformed question is cancelled, never
 * handed to the approval policy.
 */
export function antigravityQuestion(params: JsonObject): AntigravityQuestion | undefined {
  if (!isAntigravityQuestionRequest(params)) return undefined;
  const toolCall = params.toolCall as JsonObject;
  const rawOptions = Array.isArray(params.options) ? params.options : [];
  if (rawOptions.length === 0 || rawOptions.length > MAX_OPTIONS) return undefined;
  const seen = new Set<string>();
  const options: AntigravityQuestion["options"] = [];
  for (const raw of rawOptions) {
    if (!isObject(raw) || typeof raw.optionId !== "string") return undefined;
    const id = raw.optionId;
    if (!id.trim() || id.length > MAX_OPTION_ID || seen.has(id)) return undefined;
    seen.add(id);
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
    options.push({ id, label: name.slice(0, MAX_OPTION_LABEL) });
  }
  const title =
    typeof toolCall.title === "string" && toolCall.title.trim()
      ? toolCall.title.trim()
      : "Choose an option.";
  return { question: title.slice(0, MAX_QUESTION_TEXT), options };
}

/**
 * The permission response for a question card's answer: exactly one of the
 * offered option ids, once; anything else (several, none, an unknown id, a
 * cancel) cancels the request.
 */
export function antigravityQuestionResponse(
  question: AntigravityQuestion,
  result: JsonObject,
): JsonObject {
  if (result.outcome === "accepted" && isObject(result.answers)) {
    const values = Object.values(result.answers).flatMap((value) =>
      Array.isArray(value) ? value : [],
    );
    const [only] = values;
    if (
      values.length === 1 &&
      typeof only === "string" &&
      question.options.some((option) => option.id === only)
    ) {
      return { outcome: { outcome: "selected", optionId: only } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

/**
 * Native session modes that are approval policies, not conversation modes.
 *
 * agy's documented modes include `auto` and `accept-edits` beside
 * `default` and `plan`. Shown as ordinary Build/Plan choices they would let a
 * mode switch bypass Orkestrator's own permission selector, so they are left
 * out of the composer's modes. Build is `default`, Plan is `plan`.
 */
const APPROVAL_POLICY_MODE_IDS: ReadonlySet<string> = new Set([
  "auto",
  "accept-edits",
  "acceptEdits",
  "accept_edits",
  "yolo",
  "bypassPermissions",
]);

export function isAntigravityApprovalPolicyMode(modeId: string): boolean {
  return APPROVAL_POLICY_MODE_IDS.has(modeId);
}
