import { describe, expect, test } from "bun:test";
import { CODEX_FALLBACK_MODEL_CATALOG } from "@orkestrator/protocol/codex-model-catalog";
import { REASONING_DESCRIPTIONS, REASONING_LABELS } from "./models-cache.js";

// Importing index.ts starts the Hono app; guard against binding a real server.
process.env.CODEX_BRIDGE_NO_SERVER = "1";

const { __testing } = await import("./index.js");
const FALLBACK_MODELS = __testing.FALLBACK_MODELS;

// The fallback catalog is projected from the shared protocol catalogue: each
// model carries its effort ladder in both `reasoningEfforts` and
// `reasoningOptions`, and each option's label/description must come from the
// shared REASONING_* tables. These tests guard the projection.
describe("codex-bridge FALLBACK_MODELS", () => {
  test("projects the shared protocol catalogue, in order", () => {
    const summary = (models: readonly { id: string; name: string }[]) =>
      models.map(({ id, name }) => ({ id, name }));
    expect(summary(FALLBACK_MODELS)).toEqual(summary(CODEX_FALLBACK_MODEL_CATALOG));
  });

  test("exposes at least one model with a stable id/name", () => {
    expect(FALLBACK_MODELS.length).toBeGreaterThan(0);
    for (const model of FALLBACK_MODELS) {
      expect(typeof model.id).toBe("string");
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.name).toBe("string");
      expect(model.name.length).toBeGreaterThan(0);
    }
  });

  test("model ids are unique", () => {
    const ids = FALLBACK_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const model of FALLBACK_MODELS) {
    describe(`model "${model.id}"`, () => {
      test("reasoningOptions efforts match reasoningEfforts exactly and in order", () => {
        const optionEfforts = (model.reasoningOptions ?? []).map((o) => o.effort);
        expect(optionEfforts).toEqual(model.reasoningEfforts ?? []);
      });

      test("each reasoningOption uses the shared label/description tables", () => {
        for (const option of model.reasoningOptions ?? []) {
          expect(option.label).toBe(REASONING_LABELS[option.effort]);
          expect(option.description).toBe(REASONING_DESCRIPTIONS[option.effort]);
        }
      });

      test("defaultReasoningEffort is one of the supported efforts", () => {
        if (model.defaultReasoningEffort !== undefined) {
          expect(model.reasoningEfforts ?? []).toContain(model.defaultReasoningEffort);
        }
      });
    });
  }
});
