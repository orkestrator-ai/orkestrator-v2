import { describe, expect, test } from "bun:test";
import {
  COORDINATOR_DELEGATION_FRAME_CLOSE,
  COORDINATOR_DELEGATION_FRAME_OPEN,
  COORDINATOR_DELEGATION_FRAME_SEPARATOR,
} from "@orkestrator/protocol/review-evidence-frames";
import {
  createStartupPromptPreviewMessage,
  INITIAL_STARTUP_PROMPT_PREVIEW_STATE,
  nextStartupPromptPreviewState,
  startupPromptDisplayText,
  type StartupPromptPreviewInput,
} from "./startup-prompt-preview";
import { isClientOnlyNativeMessage } from "@/lib/chat/client-only-messages";

const NOW = "2026-10-31T00:00:00.000Z";
const clock = () => NOW;

function input(overrides: Partial<StartupPromptPreviewInput> = {}): StartupPromptPreviewInput {
  return {
    source: "Fix the login bug",
    backendOwned: false,
    tabInitialPrompt: "Fix the login bug",
    hasAuthoritativeMessages: false,
    launchFailed: false,
    ...overrides,
  };
}

describe("nextStartupPromptPreviewState", () => {
  test("latches the opening prompt before any session exists", () => {
    const next = nextStartupPromptPreviewState(
      INITIAL_STARTUP_PROMPT_PREVIEW_STATE,
      input(),
      clock,
    );
    expect(next.preview).toEqual({
      text: "Fix the login bug",
      createdAt: NOW,
      backendOwned: false,
    });
    // Stable across renders, so render-time setState settles.
    expect(nextStartupPromptPreviewState(next, input(), clock)).toBe(next);
  });

  test("shows nothing for a blank prompt or an existing conversation", () => {
    const initial = INITIAL_STARTUP_PROMPT_PREVIEW_STATE;
    expect(nextStartupPromptPreviewState(initial, input({ source: "  " }), clock)).toBe(initial);
    expect(nextStartupPromptPreviewState(initial, input({ source: undefined }), clock)).toBe(
      initial,
    );
    expect(
      nextStartupPromptPreviewState(initial, input({ hasAuthoritativeMessages: true }), clock),
    ).toBe(initial);
  });

  test("retires once the transcript has a row of its own, and never returns", () => {
    const shown = nextStartupPromptPreviewState(
      INITIAL_STARTUP_PROMPT_PREVIEW_STATE,
      input(),
      clock,
    );
    const retired = nextStartupPromptPreviewState(
      shown,
      input({ hasAuthoritativeMessages: true }),
      clock,
    );
    expect(retired).toEqual({ preview: null, retired: true });
    expect(nextStartupPromptPreviewState(retired, input(), clock)).toBe(retired);
  });

  test("a tab's own prompt retires when the tab consumes it", () => {
    const shown = nextStartupPromptPreviewState(
      INITIAL_STARTUP_PROMPT_PREVIEW_STATE,
      input(),
      clock,
    );
    expect(
      nextStartupPromptPreviewState(
        shown,
        input({ source: undefined, tabInitialPrompt: undefined }),
        clock,
      ).preview,
    ).toBeNull();
  });

  test("a backend-owned prompt outlives the launch flags until its echo lands", () => {
    const backend = input({ backendOwned: true, tabInitialPrompt: undefined });
    const shown = nextStartupPromptPreviewState(
      INITIAL_STARTUP_PROMPT_PREVIEW_STATE,
      backend,
      clock,
    );
    expect(shown.preview?.backendOwned).toBe(true);
    // Dispatch returned and the launch flags cleared, but no echo yet.
    expect(
      nextStartupPromptPreviewState(
        shown,
        { ...backend, backendOwned: false, source: undefined },
        clock,
      ),
    ).toBe(shown);
    expect(
      nextStartupPromptPreviewState(shown, { ...backend, hasAuthoritativeMessages: true }, clock)
        .preview,
    ).toBeNull();
  });

  test("a backend launch that gave up retires the prompt and does not show it", () => {
    const backend = input({ backendOwned: true, tabInitialPrompt: undefined });
    const shown = nextStartupPromptPreviewState(
      INITIAL_STARTUP_PROMPT_PREVIEW_STATE,
      backend,
      clock,
    );
    expect(
      nextStartupPromptPreviewState(shown, { ...backend, launchFailed: true }, clock).preview,
    ).toBeNull();
    expect(
      nextStartupPromptPreviewState(
        INITIAL_STARTUP_PROMPT_PREVIEW_STATE,
        {
          ...backend,
          launchFailed: true,
        },
        clock,
      ).preview,
    ).toBeNull();
  });
});

describe("startupPromptDisplayText", () => {
  test("shows the user's text inside a coordinator delegation frame", () => {
    const framed =
      `${COORDINATOR_DELEGATION_FRAME_OPEN}\n{"kind":"delegation"}\n` +
      `${COORDINATOR_DELEGATION_FRAME_CLOSE}${COORDINATOR_DELEGATION_FRAME_SEPARATOR}` +
      "Build the export button";
    expect(startupPromptDisplayText(framed)).toBe("Build the export button");
    expect(startupPromptDisplayText("  plain prompt \n")).toBe("plain prompt");
  });
});

test("the preview row is client-only and distinct from a submitted prompt's bubble", () => {
  const message = createStartupPromptPreviewMessage("env-1:tab", {
    text: "Fix the login bug",
    createdAt: NOW,
    backendOwned: false,
  });
  expect(message.role).toBe("user");
  expect(message.content).toBe("Fix the login bug");
  expect(message.id).not.toBe("optimistic-native:env-1:tab");
  expect(isClientOnlyNativeMessage(message)).toBe(true);
});
