import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  exitCodeForError,
  formatPublicNamespace,
  isPublicActionAvailable,
  isPublicActionResponse,
  isPublicCapabilities,
  isPublicNamespace,
  isPublicReceipt,
  isPublicRequestId,
  parsePublicDuration,
  PUBLIC_ACTIONS,
  PUBLIC_API_LIMITS,
  PUBLIC_ERROR_EXIT,
  PUBLIC_EXIT,
  publicErrorEnvelope,
  publicNamespaceCreatedAt,
  publicSuccessEnvelope,
} from "./public-api.js";
import {
  decodePublicPageCursor,
  decodePublicSessionId,
  encodePublicPageCursor,
  encodePublicSessionId,
  PUBLIC_ENVIRONMENT_SETTINGS,
  PUBLIC_PROJECT_SETTINGS,
} from "./public-api-resources.js";
import { PUBLIC_API_FIXTURES } from "./public-api-fixtures.js";

describe("public action catalogue", () => {
  test("every mutation declares effects and every read declares none", () => {
    for (const [name, descriptor] of Object.entries(PUBLIC_ACTIONS)) {
      if (descriptor.mutation) {
        expect({ name, effects: descriptor.effects.length > 0 }).toEqual({ name, effects: true });
        expect(descriptor.observation).not.toBe("immediate");
      } else {
        expect({ name, effects: descriptor.effects.length }).toEqual({ name, effects: 0 });
        expect(descriptor.observation).toBe("immediate");
      }
    }
  });

  test("project.create names its external GitHub effect", () => {
    expect(PUBLIC_ACTIONS["project.create"].effects).toContain("external-repository");
    expect(PUBLIC_ACTIONS["project.create"].summary).toContain("PRIVATE GitHub");
  });

  test("availability requires the advertised version to match the client's", () => {
    const capabilities = {
      actions: {
        "project.list": { version: 1, available: true },
        "project.add": { version: 2, available: true },
        "project.remove": { version: 1, available: false, reason: "disabled" },
      },
    };
    expect(isPublicActionAvailable(capabilities, "project.list")).toBe(true);
    expect(isPublicActionAvailable(capabilities, "project.add")).toBe(false);
    expect(isPublicActionAvailable(capabilities, "project.remove")).toBe(false);
    expect(isPublicActionAvailable(capabilities, "project.get")).toBe(false);
  });
});

describe("exit mapping", () => {
  test("every error code maps into a documented exit class", () => {
    const classes = new Set<number>(Object.values(PUBLIC_EXIT));
    for (const code of Object.keys(PUBLIC_ERROR_EXIT) as Array<keyof typeof PUBLIC_ERROR_EXIT>) {
      if (code === "observation-interrupted") {
        expect(exitCodeForError(code)).toBe(130);
        continue;
      }
      expect(classes.has(exitCodeForError(code))).toBe(true);
      expect(exitCodeForError(code)).not.toBe(PUBLIC_EXIT.success);
    }
  });

  test("uses the documented class for representative codes", () => {
    expect(exitCodeForError("invalid-input")).toBe(2);
    expect(exitCodeForError("ambiguous-target")).toBe(3);
    expect(exitCodeForError("auth-failed")).toBe(4);
    expect(exitCodeForError("deadline-exceeded")).toBe(5);
    expect(exitCodeForError("interaction-required")).toBe(6);
    expect(exitCodeForError("dispatch-unknown")).toBe(7);
    expect(exitCodeForError("request-conflict")).toBe(8);
    expect(exitCodeForError("run-failed")).toBe(1);
  });
});

describe("envelopes", () => {
  test("every fixture is a valid response with a consistent exit code", () => {
    for (const [name, fixture] of Object.entries(PUBLIC_API_FIXTURES)) {
      expect({ name, valid: isPublicActionResponse(fixture) }).toEqual({ name, valid: true });
      if (!fixture.ok) expect(fixture.error.exitCode).toBe(exitCodeForError(fixture.error.code));
    }
  });

  test("unknown and partial outcomes keep their resource identities", () => {
    const unknown = PUBLIC_API_FIXTURES.promptUnknown;
    expect(unknown.ok).toBe(false);
    expect(unknown.receipt?.state).toBe("unknown");
    expect(unknown.receipt?.resources.sessionId).toBeDefined();
    expect(decodePublicSessionId(unknown.receipt?.resources.sessionId)).toEqual({
      environmentId: "11111111-1111-4111-8111-111111111111",
      tabId: "startup-agent",
    });
    const partial = PUBLIC_API_FIXTURES.partialLaunch;
    expect(partial.receipt?.state).toBe("partial");
    expect(partial.receipt?.resources.environmentId).toBeDefined();
  });

  test("rejects contradictory and unknown-version envelopes", () => {
    const success = publicSuccessEnvelope("project.list", []);
    expect(isPublicActionResponse(success)).toBe(true);
    expect(isPublicActionResponse({ ...success, schemaVersion: 2 })).toBe(false);
    expect(isPublicActionResponse({ ...success, error: { code: "conflict" } })).toBe(false);
    const { result: _result, ...withoutResult } = success;
    expect(isPublicActionResponse(withoutResult)).toBe(false);
    const failure = publicErrorEnvelope("project.list", { code: "not-found", message: "x" });
    expect(isPublicActionResponse(failure)).toBe(true);
    expect(isPublicActionResponse({ ...failure, result: [] })).toBe(false);
    expect(isPublicActionResponse({ ...failure, error: { ...failure.error, exitCode: 1 } })).toBe(
      false,
    );
    expect(
      isPublicActionResponse({ ...failure, error: { ...failure.error, code: "made-up" } }),
    ).toBe(false);
    expect(isPublicActionResponse({ ...success, ok: "yes" })).toBe(false);
    expect(isPublicActionResponse({ ...success, receipt: { operationId: "x" } })).toBe(false);
  });

  test("receipts require identity, state and retention fields", () => {
    const receipt = PUBLIC_API_FIXTURES.environmentCreated.receipt!;
    expect(isPublicReceipt(receipt)).toBe(true);
    expect(isPublicReceipt({ ...receipt, state: "done" })).toBe(false);
    expect(isPublicReceipt({ ...receipt, requestId: "" })).toBe(false);
    expect(isPublicReceipt({ ...receipt, action: "rpc.invoke" })).toBe(false);
  });
});

describe("request keys", () => {
  test("accepts script-friendly request IDs within bounds", () => {
    expect(isPublicRequestId("scenario-1:create")).toBe(true);
    expect(isPublicRequestId("a".repeat(PUBLIC_API_LIMITS.requestIdMaxChars))).toBe(true);
    expect(isPublicRequestId("a".repeat(PUBLIC_API_LIMITS.requestIdMaxChars + 1))).toBe(false);
    expect(isPublicRequestId("")).toBe(false);
    expect(isPublicRequestId("has space")).toBe(false);
    expect(isPublicRequestId("-leading")).toBe(false);
    expect(isPublicRequestId("line\nbreak")).toBe(false);
  });

  test("namespaces encode their creation time", () => {
    const namespace = formatPublicNamespace(1_790_000_000_000, "0a1b2c3d");
    expect(isPublicNamespace(namespace)).toBe(true);
    expect(publicNamespaceCreatedAt(namespace)).toBe(1_790_000_000_000);
    expect(isPublicNamespace("ns-123-abc")).toBe(false);
    expect(publicNamespaceCreatedAt("nope")).toBeNull();
  });

  test("canonical JSON ignores key order and undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: "x" }] })).toBe(
      canonicalJson({ a: [2, { c: "x" }], b: 1 }),
    );
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe("capabilities", () => {
  test("validates the minimum identity and namespace fields", () => {
    const capabilities = {
      schemaVersion: 1,
      backend: { installationId: "i", generation: "g", version: "2.16.5", startedAt: "t" },
      actions: { "project.list": { version: 1, available: true } },
      limits: PUBLIC_API_LIMITS,
      requestKeys: {
        currentNamespace: formatPublicNamespace(1, "0a1b2c3d"),
        admissionWindowMs: 1,
        retentionMs: 1,
        retainedNamespaces: [],
      },
      providers: {},
      features: {},
    };
    expect(isPublicCapabilities(capabilities)).toBe(true);
    expect(isPublicCapabilities({ ...capabilities, schemaVersion: 2 })).toBe(false);
    expect(
      isPublicCapabilities({
        ...capabilities,
        backend: { ...capabilities.backend, generation: "" },
      }),
    ).toBe(false);
  });
});

describe("durations", () => {
  test("parses documented units", () => {
    expect(parsePublicDuration("250ms")).toBe(250);
    expect(parsePublicDuration("30s")).toBe(30_000);
    expect(parsePublicDuration("2m")).toBe(120_000);
    expect(parsePublicDuration("1.5h")).toBe(5_400_000);
    expect(parsePublicDuration("45")).toBe(45_000);
    expect(parsePublicDuration("-1s")).toBeNull();
    expect(parsePublicDuration("1d")).toBeNull();
    expect(parsePublicDuration("")).toBeNull();
  });
});

describe("session handles", () => {
  test("round-trip and reject non-canonical or malformed handles", () => {
    const id = encodePublicSessionId("env-1", "agent-job-abc");
    expect(decodePublicSessionId(id)).toEqual({ environmentId: "env-1", tabId: "agent-job-abc" });
    expect(decodePublicSessionId(`${id}=`)).toBeNull();
    expect(decodePublicSessionId("ses_!!")).toBeNull();
    expect(decodePublicSessionId("env-1")).toBeNull();
    expect(decodePublicSessionId(42)).toBeNull();
    expect(() => encodePublicSessionId("env\n1", "tab")).toThrow();
  });
});

describe("page cursors", () => {
  test("expire when the collection fingerprint changes", () => {
    const cursor = encodePublicPageCursor(50, "fp-1");
    expect(decodePublicPageCursor(cursor, "fp-1")).toEqual({ offset: 50 });
    expect(decodePublicPageCursor(cursor, "fp-2")).toBe("expired");
    expect(decodePublicPageCursor("%%%", "fp-1")).toBe("invalid");
  });
});

describe("settings schema", () => {
  test("keys are unique within each scope and excludes credentials", () => {
    for (const settings of [PUBLIC_PROJECT_SETTINGS, PUBLIC_ENVIRONMENT_SETTINGS]) {
      const keys = settings.map((setting) => setting.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.some((key) => /token|secret|credential|password/i.test(key))).toBe(false);
    }
  });
});
