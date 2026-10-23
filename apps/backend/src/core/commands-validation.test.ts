import { describe, expect, test } from "bun:test";
import {
  MAX_EXECUTION_PROFILE_ID_LENGTH,
  asDispatchNativeAgentPromptInput,
  asNativeAgentControlUpdate,
} from "./commands-validation.js";

describe("asDispatchNativeAgentPromptInput", () => {
  test("carries first-session controls on the dispatch request and bounds the profile id", () => {
    const input = {
      environmentId: "env-1",
      agent: "opencode",
      logicalSessionKey: "env-env-1:tab-1",
      prompt: "hello",
      requestId: "request-1",
      sessionMode: "build",
      executionProfileId: "plan",
    };
    expect(asDispatchNativeAgentPromptInput(input)).toMatchObject({
      sessionMode: "build",
      executionProfileId: "plan",
    });
    expect(() =>
      asDispatchNativeAgentPromptInput({
        ...input,
        executionProfileId: "a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH + 1),
      }),
    ).toThrow();
  });
  test("retains bounded provider parameter defaults", () => {
    expect(
      asDispatchNativeAgentPromptInput({
        environmentId: "env-1",
        agent: "claude",
        logicalSessionKey: "env-env-1:tab-1",
        prompt: "hello",
        requestId: "request-1",
        parameterValues: { thinking: "adaptive", context1m: true },
      }).parameterValues,
    ).toEqual({ thinking: "adaptive", context1m: true });
  });
});

/*
 * Renderer–backend skew on the dispatch request. A renderer sends a command
 * intent as `command` only when its projection carries `slashCommandCatalogue`
 * (`classifyNativeCommandSubmission`), so a backend that predates the contract
 * (ff4026b4e^, whose validator copied known fields only) is never asked to
 * honour one; that side is covered by "a legacy backend without catalogue
 * state sends exactly as before" in AgentNativeTab.commands.test.tsx.
 */
describe("mixed-version: dispatch request from an older or newer renderer", () => {
  const base = {
    environmentId: "env-1",
    agent: "claude",
    logicalSessionKey: "env-env-1:tab-1",
    requestId: "request-1",
  };

  test("an older renderer's request without a command intent keeps the historical prompt", () => {
    const input = asDispatchNativeAgentPromptInput({ ...base, prompt: "  /review src  " });
    // No intent: the service applies its historical default (typed for an
    // interactive tab), and the ordinary prompt keeps its trimming.
    expect("command" in input).toBe(false);
    expect(input.prompt).toBe("/review src");
  });

  test("fields a newer renderer adds are ignored, inside the intent and beside it", () => {
    const input = asDispatchNativeAgentPromptInput({
      ...base,
      prompt: "/review src ",
      futureTopLevelField: { anything: true },
      command: {
        kind: "selected",
        commandId: "claude:/review",
        bindingRevision: "b1",
        catalogueRevision: 7,
      },
    });
    expect(input.command).toEqual({
      kind: "selected",
      commandId: "claude:/review",
      bindingRevision: "b1",
    });
    // A command's argument suffix is kept byte-for-byte.
    expect(input.prompt).toBe("/review src ");
    expect("futureTopLevelField" in input).toBe(false);
  });

  test("an intent kind this backend does not know is refused, never sent as text", () => {
    expect(() =>
      asDispatchNativeAgentPromptInput({
        ...base,
        prompt: "/review src",
        command: { kind: "selected-v2", commandId: "claude:/review" },
      }),
    ).toThrow("Native agent command intent is invalid");
  });
});

describe("asNativeAgentControlUpdate", () => {
  test("accepts an ordinary execution profile id", () => {
    expect(asNativeAgentControlUpdate({ executionProfileId: "plan" })).toEqual({
      executionProfileId: "plan",
    });
  });

  test("trims an execution profile id before measuring it", () => {
    expect(asNativeAgentControlUpdate({ executionProfileId: "  reviewer  " })).toEqual({
      executionProfileId: "reviewer",
    });
    // Padding must not count towards the bound, or a legal id becomes illegal
    // purely by how the client serialised it.
    const padded = ` ${"a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH)} `;
    expect(asNativeAgentControlUpdate({ executionProfileId: padded })).toEqual({
      executionProfileId: "a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH),
    });
  });

  test("keeps an explicit null, which clears the stored selection", () => {
    expect(asNativeAgentControlUpdate({ executionProfileId: null })).toEqual({
      executionProfileId: null,
    });
  });

  test("rejects a blank execution profile id", () => {
    expect(() => asNativeAgentControlUpdate({ executionProfileId: "   " })).toThrow(
      "Expected executionProfileId to be a non-blank string",
    );
  });

  test("bounds the execution profile id length", () => {
    // The id is persisted to the sessions file and forwarded verbatim as the
    // provider's `agent` name, and the empty-listing branch accepts it without
    // a list to check against, so the length bound is the only thing between a
    // client and an arbitrarily large stored value.
    expect(
      asNativeAgentControlUpdate({
        executionProfileId: "a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH),
      }),
    ).toEqual({
      executionProfileId: "a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH),
    });
    expect(() =>
      asNativeAgentControlUpdate({
        executionProfileId: "a".repeat(MAX_EXECUTION_PROFILE_ID_LENGTH + 1),
      }),
    ).toThrow(
      `Expected executionProfileId to be at most ${MAX_EXECUTION_PROFILE_ID_LENGTH} characters`,
    );
  });

  test("rejects an unknown field rather than dropping it", () => {
    expect(() => asNativeAgentControlUpdate({ nope: true })).toThrow(
      "Native agent control update has unknown fields",
    );
  });

  test("rejects an empty update", () => {
    expect(() => asNativeAgentControlUpdate({})).toThrow(
      "Native agent control update must not be empty",
    );
  });
});
