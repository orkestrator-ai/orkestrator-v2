import { describe, expect, test } from "bun:test";
import { PromptRejectedError } from "../agent-provider-contract.js";
import { fakeOpenCode2Model } from "./fake-server.test-support.js";
import {
  OpenCode2ModelCatalogueCache,
  normalizeOpenCode2ModelCatalogue,
  openCode2ModelSelection,
} from "./models.js";

describe("normalizeOpenCode2ModelCatalogue", () => {
  const rows = [
    fakeOpenCode2Model("opencode", "big-pickle"),
    fakeOpenCode2Model("opencode", "flint", ["low", "high", "default"]),
    fakeOpenCode2Model("anthropic", "claude", ["high"]),
    fakeOpenCode2Model("opencode", "off", [], { enabled: false }),
    fakeOpenCode2Model("opencode", "painter", [], { type: "image" }),
    { providerID: "opencode" },
  ];

  test("variants are the effort axis after the shared default; settings never leave", () => {
    const catalogue = normalizeOpenCode2ModelCatalogue(rows, rows[1], []);
    const flint = catalogue.models.find((model) => model.id === "opencode/flint")!;
    expect(flint.reasoning).toEqual([
      { id: "default", label: "Default" },
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);
    expect(flint).toMatchObject({
      platform: "opencode",
      defaultReasoningId: "default",
      supportsSpeed: false,
      supportsMode: false,
      contextWindow: 16000,
      supportsImageInput: true,
      sessionDefault: true,
    });
    expect(catalogue.selectedModelId).toBe("opencode/flint");
    expect(catalogue.models.map((model) => model.id)).toEqual([
      "opencode/big-pickle",
      "opencode/flint",
      "anthropic/claude",
    ]);
    expect(JSON.stringify(catalogue.models)).not.toContain("fake-provider-key");
    expect(catalogue.connectedProviderIds.sort()).toEqual(["anthropic", "opencode"]);
  });

  test("the allowlist shapes the picker, not what can be dispatched", () => {
    const catalogue = normalizeOpenCode2ModelCatalogue(rows, rows[2], ["opencode"]);
    expect(catalogue.models.map((model) => model.id)).toEqual([
      "opencode/big-pickle",
      "opencode/flint",
    ]);
    // An excluded provider's default is not pre-selected…
    expect(catalogue.selectedModelId).toBeUndefined();
    // …but its models stay dispatchable.
    expect(openCode2ModelSelection("anthropic/claude", "high", catalogue)).toEqual({
      providerID: "anthropic",
      id: "claude",
      variant: "high",
    });
  });
});

describe("openCode2ModelSelection", () => {
  const catalogue = normalizeOpenCode2ModelCatalogue(
    [fakeOpenCode2Model("openrouter", "anthropic/claude", ["low"])],
    null,
    [],
  );

  test("splits on the first slash and sends default as no variant", () => {
    expect(openCode2ModelSelection("openrouter/anthropic/claude", "default", catalogue)).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude",
    });
    expect(openCode2ModelSelection("openrouter/anthropic/claude", "low", catalogue)).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude",
      variant: "low",
    });
  });

  test("refuses what 2.x would accept silently", () => {
    expect(() => openCode2ModelSelection("nope/model", undefined, catalogue)).toThrow(
      PromptRejectedError,
    );
    expect(() => openCode2ModelSelection("openrouter/anthropic/claude", "max", catalogue)).toThrow(
      'no "max" reasoning level',
    );
    expect(() => openCode2ModelSelection("bare", undefined, catalogue)).toThrow("provider/model");
    // An unreadable catalogue does not block the switch.
    expect(openCode2ModelSelection("nope/model", "x", undefined)).toEqual({
      providerID: "nope",
      id: "model",
      variant: "x",
    });
  });
});

describe("OpenCode2ModelCatalogueCache", () => {
  test("serves one read per TTL and re-reads when the allowlist changes", async () => {
    let reads = 0;
    let allowed: string[] = ["opencode"];
    let now = 0;
    const client = {
      api: async (_method: string, path: string) => {
        if (path === "/api/model") reads += 1;
        return path === "/api/model" ? [fakeOpenCode2Model("opencode", "a")] : null;
      },
    } as never;
    const cache = new OpenCode2ModelCatalogueCache(
      client,
      async () => allowed,
      () => now,
      1_000,
    );
    await cache.read();
    await cache.read();
    expect(reads).toBe(1);
    allowed = [];
    await cache.read();
    expect(reads).toBe(2);
    now = 5_000;
    await cache.read();
    expect(reads).toBe(3);
  });
});
