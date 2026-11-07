import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  InvalidEnvelopeError,
  InvokeEnvelopeSchema,
  MAX_CRITICAL_FIELDS,
  decodeInvokeEnvelope,
  isArgKey,
} from "./envelope.js";

function decoded(body: unknown) {
  const result = decodeInvokeEnvelope(body);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

function refusal(body: unknown): InvalidEnvelopeError {
  const result = decodeInvokeEnvelope(body);
  if (Result.isSuccess(result)) throw new Error("expected a refusal");
  return result.failure;
}

const keys = (count: number) => Array.from({ length: count }, (_, index) => `key${index}`);

describe("decodeInvokeEnvelope", () => {
  it("accepts today's two-field body and the full envelope", () => {
    expect(decoded({ command: "get_config", args: {} })).toEqual({
      command: "get_config",
      args: {},
    });
    expect(decoded({ command: "get_config" })).toEqual({ command: "get_config" });
    const full = {
      command: "deliver_node_mail",
      args: { steer: true },
      domain: "node-mail",
      version: 3,
      critical: ["steer"],
    };
    expect(decoded(full)).toEqual(full);
  });

  it("ignores unknown envelope keys", () => {
    expect(decoded({ command: "x", args: { a: 1 }, trace: "t", future: { y: 1 } })).toEqual({
      command: "x",
      args: { a: 1 },
    });
  });

  it("bounds the critical list", () => {
    expect(decoded({ command: "x", critical: keys(MAX_CRITICAL_FIELDS) }).critical).toHaveLength(
      MAX_CRITICAL_FIELDS,
    );
    expect(decoded({ command: "x", critical: [] }).critical).toEqual([]);
    const error = refusal({ command: "x", critical: keys(MAX_CRITICAL_FIELDS + 1) });
    expect(error).toBeInstanceOf(InvalidEnvelopeError);
    expect(error.message).toContain("critical");
  });

  it("refuses a malformed critical list instead of dropping it", () => {
    for (const critical of [
      "steer",
      { steer: true },
      [1],
      [""],
      ["has space"],
      ["dotted.key"],
      ["1leading"],
      ["k".repeat(65)],
      [null],
    ]) {
      expect(refusal({ command: "x", critical }).message).toContain("critical");
    }
  });

  it("refuses a malformed domain or version, and a body without a command", () => {
    expect(refusal({ command: "x", domain: "Node_Mail" }).message).toContain("domain");
    expect(refusal({ command: "x", domain: "" }).message).toContain("domain");
    expect(refusal({ command: "x", version: 1.5 }).message).toContain("version");
    expect(refusal({ command: "x", version: -1 }).message).toContain("version");
    expect(refusal({ command: "x", version: 1_001 }).message).toContain("version");
    expect(refusal({ command: "x", version: "1" }).message).toContain("version");
    expect(refusal({ args: {} }).message).toBe("Expected command to be a string");
    expect(refusal([]).message).toContain("object");
    expect(refusal(null).message).toContain("object");
  });

  it("never echoes a refused value", () => {
    const secret = "sk-secret-value";
    expect(refusal({ command: "x", critical: [secret, 1] }).message).not.toContain(secret);
    expect(refusal({ command: "x", domain: secret.toUpperCase() }).message).not.toContain(
      secret.toUpperCase(),
    );
  });
});

describe("isArgKey", () => {
  it("accepts identifiers up to 64 characters", () => {
    expect(isArgKey("projectId")).toBe(true);
    expect(isArgKey("_private2")).toBe(true);
    expect(isArgKey("k".repeat(64))).toBe(true);
    expect(isArgKey("k".repeat(65))).toBe(false);
    expect(isArgKey("a-b")).toBe(false);
    expect(isArgKey(7)).toBe(false);
  });
});

describe("InvokeEnvelopeSchema", () => {
  it("exports a JSON Schema with the bounds", () => {
    const document = Schema.toJsonSchemaDocument(InvokeEnvelopeSchema);
    const json = JSON.stringify(document);
    expect(json).toContain(`"maxItems":${MAX_CRITICAL_FIELDS}`);
    expect(json).toContain('"pattern":"^[a-z][a-z0-9-]*$"');
    expect(json).toContain('"pattern":"^[A-Za-z_][A-Za-z0-9_]*$"');
  });
});
