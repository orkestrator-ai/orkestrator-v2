import { describe, expect, it } from "bun:test";
import {
  ACTION_DEFAULT_KEYS,
  normalizeActionDefaults,
  resolveActionDefault,
} from "./action-defaults.js";

describe("normalizeActionDefaults", () => {
  it("returns an empty object for anything that is not a record", () => {
    for (const value of [undefined, null, "review", 7, ["review"]]) {
      expect(normalizeActionDefaults(value)).toEqual({});
    }
  });

  it("keeps well-formed entries and trims their strings", () => {
    expect(
      normalizeActionDefaults({
        createScript: { platform: "claude", model: " sonnet ", reasoningEffort: " high " },
        review: { platform: "codex", model: " gpt-5.4 ", reasoningEffort: " high " },
        review2: { platform: "claude", model: " opus " },
        fixReviewIssues: { platform: "codex", model: " gpt-5.6 " },
      }),
    ).toEqual({
      createScript: { platform: "claude", model: "sonnet", reasoningEffort: "high" },
      review: { platform: "codex", model: "gpt-5.4", reasoningEffort: "high" },
      review2: { platform: "claude", model: "opus" },
      fixReviewIssues: { platform: "codex", model: "gpt-5.6" },
    });
  });

  it("drops unknown action keys", () => {
    expect(
      normalizeActionDefaults({
        review: { platform: "claude" },
        deploy: { platform: "claude" },
      }),
    ).toEqual({ review: { platform: "claude" } });
  });

  it("drops an entry without a valid platform", () => {
    // A model id only means something inside its own platform's catalogue, so
    // an entry that names one without the other cannot be honoured.
    expect(
      normalizeActionDefaults({
        review: { model: "sonnet" },
        pr: { platform: "not-an-agent", model: "sonnet" },
        push: { platform: "claude" },
      }),
    ).toEqual({ push: { platform: "claude" } });
  });

  it("drops blank model and reasoning values rather than persisting them", () => {
    expect(
      normalizeActionDefaults({
        pr: { platform: "claude", model: "   ", reasoningEffort: "" },
      }),
    ).toEqual({ pr: { platform: "claude" } });
  });

  it("drops OpenCode's placeholder model but keeps the rest of the entry", () => {
    // `default` is the id the catalog builder synthesises when no OpenCode
    // models are cached. No OpenCode server knows it, so persisting it would
    // pin a bogus one-shot model; the entry still means "OpenCode's own
    // default model", which is what the placeholder stood for.
    expect(
      normalizeActionDefaults({
        push: { platform: "opencode", model: "default", reasoningEffort: "high" },
      }),
    ).toEqual({ push: { platform: "opencode", reasoningEffort: "high" } });
  });

  it("keeps `default` for platforms where it is a real catalog id", () => {
    expect(
      normalizeActionDefaults({
        review: { platform: "claude", model: "default" },
      }),
    ).toEqual({ review: { platform: "claude", model: "default" } });
  });

  it("serializes to a canonical key order regardless of input order", () => {
    const reversed = [...ACTION_DEFAULT_KEYS].reverse();
    const input: Record<string, unknown> = {};
    for (const key of reversed) input[key] = { platform: "claude" };
    expect(Object.keys(normalizeActionDefaults(input))).toEqual([...ACTION_DEFAULT_KEYS]);
  });
});

describe("resolveActionDefault", () => {
  const enabledAgents = ["claude", "codex"] as const;

  it("falls back to the caller's agent when nothing is configured", () => {
    expect(
      resolveActionDefault(undefined, "review", {
        fallbackAgent: "claude",
        enabledAgents,
      }),
    ).toEqual({ agent: "claude" });
    expect(
      resolveActionDefault({}, "review", {
        fallbackAgent: "codex",
        enabledAgents,
      }),
    ).toEqual({ agent: "codex" });
  });

  it("returns the configured platform, model and reasoning level", () => {
    expect(
      resolveActionDefault(
        { review: { platform: "codex", model: "gpt-5.4", reasoningEffort: "xhigh" } },
        "review",
        { fallbackAgent: "claude", enabledAgents },
      ),
    ).toEqual({ agent: "codex", model: "gpt-5.4", reasoningEffort: "xhigh" });
  });

  it("ignores a default whose platform has since been disabled", () => {
    // The model belongs to the disabled platform; carrying it onto the
    // fallback agent would launch a model that agent does not have.
    expect(
      resolveActionDefault(
        { pr: { platform: "opencode", model: "opencode/claude-sonnet-5" } },
        "pr",
        { fallbackAgent: "claude", enabledAgents },
      ),
    ).toEqual({ agent: "claude" });
  });

  it("applies the entry whatever the caller's fallback agent is", () => {
    // The caller's fallback is the generic cascade, which is wider than the
    // choice this action names. It answers only when the action does not.
    expect(
      resolveActionDefault(
        { review: { platform: "claude", model: "opus", reasoningEffort: "max" } },
        "review",
        { fallbackAgent: "codex", enabledAgents },
      ),
    ).toEqual({ agent: "claude", model: "opus", reasoningEffort: "max" });
  });

  it("carries the model when the entry and the fallback name the same agent", () => {
    expect(
      resolveActionDefault(
        { review: { platform: "codex", model: "gpt-5.4", reasoningEffort: "xhigh" } },
        "review",
        { fallbackAgent: "codex", enabledAgents },
      ),
    ).toEqual({ agent: "codex", model: "gpt-5.4", reasoningEffort: "xhigh" });
  });

  it("reads only the requested action's entry", () => {
    const defaults = {
      review: { platform: "codex" as const, model: "gpt-5.4" },
      push: { platform: "claude" as const },
    };
    expect(
      resolveActionDefault(defaults, "push", {
        fallbackAgent: "codex",
        enabledAgents,
      }),
    ).toEqual({ agent: "claude" });
    expect(
      resolveActionDefault(defaults, "resolve", {
        fallbackAgent: "codex",
        enabledAgents,
      }),
    ).toEqual({ agent: "codex" });
  });
});
