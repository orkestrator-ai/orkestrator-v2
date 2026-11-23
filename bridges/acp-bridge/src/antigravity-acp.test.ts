import {
  acpSignInMissing,
  ANTIGRAVITY_SIGN_IN_RECHECK_MS,
  noteAcpSignInRefused,
  noteAcpSignedIn,
  resetAcpSignInStateForTests,
} from "./acp-credentials.js";
import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  antigravityAppendsSystemPrompt,
  antigravityQuestion,
  antigravityQuestionResponse,
  isAntigravityApprovalPolicyMode,
  isAntigravityLoginBanner,
  isAntigravityQuestionRequest,
  isAntigravitySignInFailure,
} from "./antigravity-acp.js";

/** The `initialize` answer agy 1.5.12 gave a throwaway `HOME`, trimmed to what is read. */
const INITIALIZED_1_5_12 = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
    mcpCapabilities: { http: true },
    _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
  },
  agentInfo: { name: "Antigravity ACP Server", version: "1.5.12" },
  authMethods: [
    { id: "oauth-personal", name: "Log in with Google" },
    { id: "oauth-business", name: "Log in with Gemini Enterprise" },
    { id: "gemini-api-key", name: "Gemini API key" },
    { id: "agent-platform", name: "Gemini Enterprise Agent Platform" },
  ],
};

function questionRequest(options: unknown[], title = "Which database?") {
  return {
    sessionId: "s-1",
    toolCall: { toolCallId: "interaction_7", title },
    options,
  };
}

describe("Antigravity authentication", () => {
  test("classifies agy's sign-in refusals and nothing else", () => {
    expect(isAntigravitySignInFailure({ code: -32000, message: "Authentication required" })).toBe(
      true,
    );
    expect(isAntigravitySignInFailure({ code: -32800, message: "Sign-in was cancelled." })).toBe(
      true,
    );
    expect(
      isAntigravitySignInFailure({
        code: -32603,
        message:
          "No browser is available here (no graphical display is available to open a browser). Run `agy acp --login` in a terminal on this machine, then retry; or use a Gemini API key.",
      }),
    ).toBe(true);
    expect(isAntigravitySignInFailure({ code: -32603, message: "Internal error" })).toBe(false);
    const cancelled = { code: -32800, message: "Request cancelled" };
    expect(isAntigravitySignInFailure(cancelled, "session/prompt")).toBe(false);
    expect(isAntigravitySignInFailure(cancelled, "authenticate")).toBe(true);
    expect(isAntigravitySignInFailure(new Error("model unavailable"))).toBe(false);
  });

  test("rechecks after the refusal expires and clears a refusal on successful sign-in", async () => {
    try {
      noteAcpSignInRefused("antigravity", Date.now() - ANTIGRAVITY_SIGN_IN_RECHECK_MS - 1);
      expect(await acpSignInMissing("antigravity", undefined, {})).toBe(false);
      noteAcpSignInRefused("antigravity");
      expect(await acpSignInMissing("antigravity", undefined, {})).toBe(true);
      noteAcpSignedIn("antigravity");
      expect(await acpSignInMissing("antigravity", undefined, {})).toBe(false);
    } finally {
      resetAcpSignInStateForTests();
    }
  });

  test("recognises the login banner agy prints outside JSON-RPC", () => {
    expect(
      isAntigravityLoginBanner(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}https://accounts.example`),
    ).toBe(true);
    expect(isAntigravityLoginBanner('{"jsonrpc":"2.0"}')).toBe(false);
  });
});

describe("Antigravity session instructions", () => {
  test("reads the vendor carrier from initialize", () => {
    expect(antigravityAppendsSystemPrompt(INITIALIZED_1_5_12)).toBe(true);
    expect(antigravityAppendsSystemPrompt({ agentCapabilities: {} })).toBe(false);
    expect(
      antigravityAppendsSystemPrompt({
        agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: "yes" } } } },
      }),
    ).toBe(false);
  });
});

describe("Antigravity questions", () => {
  test("are told apart from approvals by their tool-call id", () => {
    expect(isAntigravityQuestionRequest(questionRequest([]))).toBe(true);
    expect(isAntigravityQuestionRequest({ toolCall: { toolCallId: "call_1" }, options: [] })).toBe(
      false,
    );
  });

  test("offer exactly the native choices and return one id once", () => {
    const question = antigravityQuestion(
      questionRequest([
        { optionId: "pg", name: "Postgres", kind: "allow_once" },
        { optionId: "sqlite", name: "", kind: "allow_once" },
      ]),
    );
    expect(question).toEqual({
      question: "Which database?",
      options: [
        { id: "pg", label: "Postgres" },
        { id: "sqlite", label: "sqlite" },
      ],
    });
    expect(
      antigravityQuestionResponse(question!, { outcome: "accepted", answers: { answer: ["pg"] } }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "pg" } });
  });

  test("cancel rather than guess", () => {
    const question = antigravityQuestion(
      questionRequest([
        { optionId: "a", name: "A" },
        { optionId: "b", name: "B" },
      ]),
    )!;
    const cancelled = { outcome: { outcome: "cancelled" } };
    expect(antigravityQuestionResponse(question, { outcome: "cancelled" })).toEqual(cancelled);
    expect(
      antigravityQuestionResponse(question, {
        outcome: "accepted",
        answers: { answer: ["a", "b"] },
      }),
    ).toEqual(cancelled);
    expect(
      antigravityQuestionResponse(question, { outcome: "accepted", answers: { answer: ["c"] } }),
    ).toEqual(cancelled);
    expect(
      antigravityQuestionResponse(question, { outcome: "accepted", answers: { answer: [] } }),
    ).toEqual(cancelled);
  });

  test("a malformed question is refused, never handed to the approval policy", () => {
    expect(antigravityQuestion(questionRequest([]))).toBeUndefined();
    expect(
      antigravityQuestion(
        questionRequest([
          { optionId: "x", name: "X" },
          { optionId: "x", name: "Again" },
        ]),
      ),
    ).toBeUndefined();
    expect(
      antigravityQuestion(questionRequest([{ optionId: " ", name: "Blank" }])),
    ).toBeUndefined();
    expect(antigravityQuestion(questionRequest(["not an option"]))).toBeUndefined();
  });
});

describe("Antigravity modes", () => {
  test("approval policies are not conversation modes", () => {
    expect(isAntigravityApprovalPolicyMode("auto")).toBe(true);
    expect(isAntigravityApprovalPolicyMode("accept-edits")).toBe(true);
    expect(isAntigravityApprovalPolicyMode("default")).toBe(false);
    expect(isAntigravityApprovalPolicyMode("plan")).toBe(false);
  });
});
