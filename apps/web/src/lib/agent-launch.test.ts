import { describe, expect, test } from "bun:test";
import {
  LAUNCH_AGENT_OPTIONS,
  defaultEffortFor,
  effortLabel,
  firstModelFor,
  type AgentModelCatalog,
} from "./agent-launch";

const catalog: AgentModelCatalog = {
  claude: [
    { id: "claude-a", name: "Claude A", reasoningEfforts: ["low", "high"] },
    { id: "claude-b", name: "Claude B", reasoningEfforts: ["xhigh"] },
    { id: "claude-fixed", name: "Claude Fixed", reasoningEfforts: [] },
  ],
  codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: ["medium", "high"] }],
  // A provider whose models have not loaded yet.
  opencode: [],
};

describe("firstModelFor", () => {
  test("keeps a preferred model the catalog still offers", () => {
    expect(firstModelFor("claude", catalog, { claude: "claude-b" })).toBe("claude-b");
    expect(firstModelFor("codex", catalog, { codex: "codex-a" })).toBe("codex-a");
  });

  test("falls back to the first model when the preference was retired", () => {
    expect(firstModelFor("claude", catalog, { claude: "claude-retired" })).toBe("claude-a");
  });

  test("reads only the requested agent's preference", () => {
    // A Codex preference must not win a Claude lookup.
    expect(firstModelFor("claude", catalog, { codex: "codex-a" })).toBe("claude-a");
  });

  test("falls back to the first model when no preferences are supplied", () => {
    expect(firstModelFor("claude", catalog)).toBe("claude-a");
  });

  test("ignores an empty preference string", () => {
    expect(firstModelFor("claude", catalog, { claude: "" })).toBe("claude-a");
  });

  test("returns the default placeholder when the agent has no models", () => {
    expect(firstModelFor("opencode", catalog)).toBe("default");
    expect(firstModelFor("opencode", catalog, { opencode: "provider/model-a" })).toBe("default");
    expect(firstModelFor("opencode", catalog, { opencode: "" })).toBe("default");
  });
});

describe("defaultEffortFor", () => {
  test("keeps a preferred effort the model still supports", () => {
    expect(defaultEffortFor("claude", "claude-a", catalog, { claude: "high" })).toBe("high");
    expect(defaultEffortFor("codex", "codex-a", catalog, { codex: "medium" })).toBe("medium");
  });

  test("drops a preferred effort the model does not support", () => {
    expect(defaultEffortFor("claude", "claude-a", catalog, { claude: "xhigh" })).toBe("default");
  });

  test("drops every effort for a model the catalog no longer lists", () => {
    expect(defaultEffortFor("claude", "claude-retired", catalog, { claude: "high" })).toBe(
      "default",
    );
  });

  test("drops every effort for a model that exposes none", () => {
    expect(defaultEffortFor("claude", "claude-fixed", catalog, { claude: "high" })).toBe("default");
  });

  test("ignores an empty preference string", () => {
    expect(defaultEffortFor("claude", "claude-a", catalog, { claude: "" })).toBe("default");
  });

  test("returns the default when no preferences are supplied", () => {
    expect(defaultEffortFor("claude", "claude-a", catalog)).toBe("default");
  });

  test("reads only the requested agent's preference", () => {
    // "high" is valid for claude-a, but it was configured for Codex.
    expect(defaultEffortFor("claude", "claude-a", catalog, { codex: "high" })).toBe("default");
  });
});

describe("effortLabel", () => {
  test("spells out the abbreviated extra-high level", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
  });

  test("capitalises every other level", () => {
    expect(effortLabel("medium")).toBe("Medium");
    expect(effortLabel("high")).toBe("High");
    expect(effortLabel("default")).toBe("Default");
  });

  test("capitalises a single-character level", () => {
    expect(effortLabel("x")).toBe("X");
  });

  test("returns an empty label for an empty level", () => {
    expect(effortLabel("")).toBe("");
  });
});

describe("LAUNCH_AGENT_OPTIONS", () => {
  test("offers every supported native agent in product order", () => {
    expect(LAUNCH_AGENT_OPTIONS).toEqual([
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
      { value: "cursor", label: "Cursor Agent" },
      { value: "grok", label: "Grok Build" },
      { value: "opencode", label: "OpenCode" },
    ]);
  });
});

describe("firstModelFor resolved-model matching", () => {
  /**
   * Configuration and the catalog do not share an id space: the global Claude
   * default is stored as `claude-sonnet-5`, while the catalog lists that model
   * under the alias `sonnet`.
   */
  const aliased: AgentModelCatalog = {
    claude: [
      {
        id: "default",
        name: "Default (recommended)",
        reasoningEfforts: ["low", "high"],
        resolvedModel: "claude-opus-5[1m]",
      },
      {
        id: "sonnet",
        name: "Sonnet",
        reasoningEfforts: ["low", "high"],
        resolvedModel: "claude-sonnet-5",
      },
    ],
    codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: [] }],
    opencode: [],
  };

  test("matches a preference stored as the resolved model", () => {
    // Without this the preference misses every entry and the launcher silently
    // opens on the catalog's first model instead of the configured one.
    expect(firstModelFor("claude", aliased, { claude: "claude-sonnet-5" })).toBe("sonnet");
  });

  test("prefers an exact catalog id over a resolved-model match", () => {
    expect(firstModelFor("claude", aliased, { claude: "default" })).toBe("default");
  });

  test("still falls back when neither the id nor the resolved model matches", () => {
    expect(firstModelFor("claude", aliased, { claude: "claude-retired-9" })).toBe("default");
  });

  test("ignores a resolved model on another agent's entries", () => {
    expect(firstModelFor("codex", aliased, { codex: "claude-sonnet-5" })).toBe("codex-a");
  });
});
