import { describe, expect, test } from "bun:test";
import {
  CLAUDE_FALLBACK_MODEL_CATALOG,
  CLAUDE_ULTRACODE_REASONING_ID,
  claudeModelParameters,
  claudeModelReasoningIds,
  claudeModelSupportsUltracode,
} from "./claude-model-catalog.js";
import { isSuppressedComposerParameter } from "./native-agent.js";

const ids = (model: Parameters<typeof claudeModelParameters>[0]) =>
  claudeModelParameters(model).map((parameter) => parameter.id);

describe("claudeModelReasoningIds", () => {
  test("offers Ultracode last, only on models that support xhigh effort", () => {
    expect(
      claudeModelReasoningIds({
        id: "default",
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      }),
    ).toEqual(["low", "medium", "high", "xhigh", "max", CLAUDE_ULTRACODE_REASONING_ID]);
    expect(
      claudeModelReasoningIds({ id: "sonnet", supportedEffortLevels: ["low", "high"] }),
    ).toEqual(["low", "high"]);
    expect(claudeModelReasoningIds({ id: "haiku" })).toEqual([]);
  });

  test("appends to an explicit effort list instead of the model's own", () => {
    expect(
      claudeModelReasoningIds({ id: "default", supportedEffortLevels: ["xhigh"] }, [
        "medium",
        "xhigh",
      ]),
    ).toEqual(["medium", "xhigh", "ultracode"]);
  });
});

describe("claudeModelParameters", () => {
  test("no longer carries Ultracode as a separate toggle", () => {
    expect(
      ids({ id: "default", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }),
    ).not.toContain("ultracode");
  });

  test("keeps the 1M-context toggle to Opus and Sonnet, resolved or aliased", () => {
    expect(ids({ id: "sonnet", resolvedModel: "claude-sonnet-5-5" })).toContain("context1m");
    expect(ids({ id: "default", resolvedModel: "claude-opus-5-5[1m]" })).toContain("context1m");
    expect(ids({ id: "haiku", resolvedModel: "claude-haiku-4-5-20251001" })).not.toContain(
      "context1m",
    );
    expect(ids({ id: "haiku" })[0]).toBe("thinking");
  });

  test("the input bar keeps suppressing the settings-backed pair", () => {
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
