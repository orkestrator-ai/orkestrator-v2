import { describe, expect, test } from "bun:test";
import {
  CLAUDE_FALLBACK_MODEL_CATALOG,
  CLAUDE_ULTRACODE_PARAMETER_ID,
  claudeModelParameters,
  claudeModelSupportsUltracode,
} from "./claude-model-catalog.js";
import { isSuppressedComposerParameter } from "./native-agent.js";

const ids = (model: Parameters<typeof claudeModelParameters>[0]) =>
  claudeModelParameters(model).map((parameter) => parameter.id);

describe("claudeModelParameters", () => {
  test("offers Ultracode only on models that support xhigh effort", () => {
    expect(
      ids({ id: "default", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }),
    ).toContain(CLAUDE_ULTRACODE_PARAMETER_ID);
    expect(ids({ id: "sonnet", supportedEffortLevels: ["low", "medium", "high"] })).not.toContain(
      CLAUDE_ULTRACODE_PARAMETER_ID,
    );
    expect(ids({ id: "haiku" })).not.toContain(CLAUDE_ULTRACODE_PARAMETER_ID);
  });

  test("Ultracode is an off-by-default session toggle", () => {
    const ultracode = claudeModelParameters({
      id: "default",
      supportedEffortLevels: ["xhigh"],
    }).find((parameter) => parameter.id === CLAUDE_ULTRACODE_PARAMETER_ID);
    expect(ultracode).toEqual({
      id: "ultracode",
      label: "Ultracode",
      kind: "toggle",
      defaultValue: false,
      scope: "session",
    });
  });

  test("keeps the 1M-context toggle to Opus and Sonnet, resolved or aliased", () => {
    expect(ids({ id: "sonnet", resolvedModel: "claude-sonnet-5-5" })).toContain("context1m");
    expect(ids({ id: "default", resolvedModel: "claude-opus-5-5[1m]" })).toContain("context1m");
    expect(ids({ id: "haiku", resolvedModel: "claude-haiku-4-5-20251001" })).not.toContain(
      "context1m",
    );
    expect(ids({ id: "haiku" })[0]).toBe("thinking");
  });

  test("the input bar renders Ultracode while it keeps suppressing the settings-backed pair", () => {
    // Ultracode is a per-session choice the CLI never persists, so it belongs
    // on the input bar, unlike thinking and context1m.
    expect(isSuppressedComposerParameter("claude", "parameter:ultracode")).toBe(false);
    expect(isSuppressedComposerParameter("claude", "parameter:thinking")).toBe(true);
    expect(isSuppressedComposerParameter("claude", "parameter:context1m")).toBe(true);
  });

  test("the shipped catalogue offers Ultracode on every xhigh-capable model", () => {
    const offered = CLAUDE_FALLBACK_MODEL_CATALOG.filter(claudeModelSupportsUltracode).map(
      (model) => model.id,
    );
    expect(offered).toEqual(["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet"]);
  });
});
