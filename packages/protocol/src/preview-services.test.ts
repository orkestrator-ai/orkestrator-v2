import { describe, expect, test } from "bun:test";
import {
  isOpaquePreviewId,
  isPreviewServiceRef,
  isUnknownPreviewCommandError,
  normalizePreviewPath,
  normalizeReadinessPath,
  parsePreviewPort,
  parsePreviewUrlIntent,
  PREVIEW_LIMITS,
  previewErrorFromUnknown,
  previewFailure,
  redactPreviewPath,
  resolvePreviewLimits,
  stablePreviewJson,
  validatePreviewServiceInput,
} from "./preview-services.js";
import {
  encodePreviewTunnelFrame,
  isReservedPreviewCookieName,
  parsePreviewTunnelClientFrame,
  parsePreviewTunnelServerFrame,
} from "./preview-access.js";
import {
  FIXTURE_BACKEND_INSTANCE_ID,
  FIXTURE_SERVICE_ID,
  fixturePreviewCapabilities,
  fixturePreviewSnapshot,
} from "./preview-contract-fixtures.js";

describe("preview ports and paths", () => {
  test("accepts only complete decimal ports", () => {
    expect(parsePreviewPort("3000")).toBe(3000);
    expect(parsePreviewPort(65_535)).toBe(65_535);
    for (const value of ["03000", "3e3", " 80", "65536", "0", "", "80a", 1.5, -1, 70_000]) {
      expect(parsePreviewPort(value)).toBeNull();
    }
  });

  test("normalizes app-relative navigation and rejects authority changes", () => {
    expect(normalizePreviewPath(undefined)).toBe("/");
    expect(normalizePreviewPath("/a/b?c=1#d")).toBe("/a/b?c=1#d");
    expect(normalizePreviewPath("?q=1")).toBe("/?q=1");
    for (const value of ["//evil.test/x", "/\\evil", "http://x/", "a/b", "/a\nb", "/\u0000"]) {
      expect(() => normalizePreviewPath(value)).toThrow("PreviewError:invalid-request");
    }
    expect(() =>
      normalizePreviewPath(`/${"a".repeat(PREVIEW_LIMITS.navigationMaxBytes)}`),
    ).toThrow();
  });

  test("readiness paths exclude fragments", () => {
    expect(normalizeReadinessPath("/health")).toBe("/health");
    expect(normalizeReadinessPath("")).toBeUndefined();
    expect(() => normalizeReadinessPath("/health#x")).toThrow();
  });

  test("redaction drops query and fragment", () => {
    expect(redactPreviewPath("/login?token=secret#frag")).toBe("/login");
    expect(redactPreviewPath(`/${"x".repeat(100)}`).length).toBeLessThanOrEqual(66);
  });
});

describe("URL intent", () => {
  test("interprets loopback addresses with their source", () => {
    expect(
      parsePreviewUrlIntent("http://localhost:3000/app?x=1", "container-terminal", "env"),
    ).toEqual({
      source: "container-terminal",
      environmentId: "env",
      scheme: "http",
      host: "localhost",
      port: 3000,
      path: "/app?x=1",
    });
    expect(parsePreviewUrlIntent("http://[::1]:5173", "address-bar", "env").host).toBe("::1");
    expect(parsePreviewUrlIntent("https://127.0.0.1/", "address-bar", "env").port).toBe(443);
  });

  test("0.0.0.0 is only a container bind hint", () => {
    expect(parsePreviewUrlIntent("http://0.0.0.0:3000/", "container-terminal", "env").host).toBe(
      "0.0.0.0",
    );
    expect(() => parsePreviewUrlIntent("http://0.0.0.0:3000/", "address-bar", "env")).toThrow();
  });

  test("rejects credentials, remote hosts, bad ports, and other schemes", () => {
    for (const value of [
      "http://user:pass@localhost:3000/",
      "http://example.com:3000/",
      "http://localhost:99999/",
      "http://localhost:/",
      "ftp://localhost:21/",
      "http://localhost:3000\n/",
      "http://localhost:3000//evil",
    ]) {
      expect(() => parsePreviewUrlIntent(value, "address-bar", "env")).toThrow(
        "PreviewError:invalid-request",
      );
    }
  });
});

describe("service input validation", () => {
  test("applies defaults and ignores unknown fields", () => {
    const value = validatePreviewServiceInput({
      environmentId: "env",
      label: " web ",
      targetKind: "container",
      applicationPort: "3000",
      containerId: "forged",
    });
    expect(value).toEqual({
      environmentId: "env",
      label: "web",
      targetKind: "container",
      applicationPort: 3000,
      scheme: "http",
      addressFamily: "auto",
      entry: false,
      enabled: true,
    });
  });

  test("rejects invalid shapes", () => {
    const base = {
      environmentId: "env",
      label: "web",
      targetKind: "container",
      applicationPort: 3000,
    };
    for (const input of [
      null,
      [],
      { ...base, label: "" },
      { ...base, label: "x".repeat(121) },
      { ...base, targetKind: "remote-host" },
      { ...base, applicationPort: 0 },
      { ...base, scheme: "ftp" },
      { ...base, scheme: "http", tlsServerName: "app.test" },
      { ...base, scheme: "https", tlsServerName: "bad name" },
      { ...base, readinessPath: "//x" },
    ]) {
      expect(() => validatePreviewServiceInput(input)).toThrow("PreviewError:invalid-request");
    }
  });

  test("service refs require opaque ids and canonical paths", () => {
    const ref = {
      backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
      environmentId: "env",
      serviceId: FIXTURE_SERVICE_ID,
      path: "/a?b#c",
    };
    expect(isPreviewServiceRef(ref)).toBe(true);
    expect(isPreviewServiceRef({ ...ref, serviceId: "3000" })).toBe(false);
    expect(isPreviewServiceRef({ ...ref, path: "a" })).toBe(false);
    expect(isPreviewServiceRef({ ...ref, backendInstanceId: "x" })).toBe(false);
    expect(isOpaquePreviewId("a".repeat(129))).toBe(false);
  });
});

describe("errors", () => {
  test("round-trip through string-only transports", () => {
    const flattened = new Error(
      `Error invoking remote method: ${previewFailure("target-unmapped").message}`,
    );
    expect(previewErrorFromUnknown(flattened)).toMatchObject({
      category: "target-unmapped",
      retryable: true,
      layer: "binding",
    });
    expect(previewErrorFromUnknown(new Error("socket hang up"))).toBeNull();
    expect(previewErrorFromUnknown(new Error("PreviewError:made-up: nope"))).toBeNull();
  });

  test("only a genuinely unknown command marks an old backend", () => {
    expect(
      isUnknownPreviewCommandError(new Error("Unknown command: get_preview_capabilities")),
    ).toBe(true);
    expect(isUnknownPreviewCommandError(new Error("Unauthorized"))).toBe(false);
    expect(isUnknownPreviewCommandError(new Error("fetch failed"))).toBe(false);
    expect(isUnknownPreviewCommandError(new Error("Unknown command: something_else"))).toBe(false);
  });
});

describe("limits", () => {
  test("overrides are validated against ceilings", () => {
    expect(resolvePreviewLimits({ httpActivePerService: 64 }).httpActivePerService).toBe(64);
    expect(() => resolvePreviewLimits({ httpActivePerService: 0 })).toThrow();
    expect(() => resolvePreviewLimits({ httpActivePerService: 100_000 })).toThrow();
    expect(() => resolvePreviewLimits({ nope: 1 })).toThrow("Unknown preview limit");
  });
});

describe("contract fixtures", () => {
  test("serialize deterministically without secrets", () => {
    const snapshot = fixturePreviewSnapshot();
    const a = stablePreviewJson(snapshot);
    const b = stablePreviewJson(JSON.parse(JSON.stringify(snapshot)));
    expect(a).toBe(b);
    expect(a).not.toMatch(/"(credential|grant|token|cookie)"/i);
    expect(stablePreviewJson(fixturePreviewCapabilities())).not.toMatch(
      /"(credential|grant|token)"/i,
    );
  });
});

describe("tunnel frames", () => {
  const credential = "c".repeat(43);
  test("accepts the exact client shapes", () => {
    expect(
      parsePreviewTunnelClientFrame(
        encodePreviewTunnelFrame({
          type: "hello",
          version: 1,
          attachmentId: "att_12345678",
          credential,
        }),
      ),
    ).toEqual({ type: "hello", version: 1, attachmentId: "att_12345678", credential });
    expect(parsePreviewTunnelClientFrame('{"type":"open"}')).toEqual({ type: "open" });
  });

  test("rejects destinations, unknown types, wrong versions, and oversize frames", () => {
    for (const text of [
      '{"type":"open","host":"127.0.0.1","port":22}',
      '{"type":"connect"}',
      JSON.stringify({ type: "hello", version: 2, attachmentId: "att_12345678", credential }),
      JSON.stringify({
        type: "hello",
        version: 1,
        attachmentId: "att_12345678",
        credential: "short",
      }),
      `{"type":"open","pad":"${"x".repeat(9000)}"}`,
      "not json",
      "[]",
    ]) {
      expect(parsePreviewTunnelClientFrame(text)).toBeNull();
    }
  });

  test("server errors are re-sanitized", () => {
    const parsed = parsePreviewTunnelServerFrame(
      JSON.stringify({
        type: "open-failed",
        error: {
          category: "connection-refused",
          message: "refused",
          retryable: false,
          layer: "request",
        },
      }),
    );
    expect(parsed).toEqual({
      type: "open-failed",
      error: { category: "connection-refused", message: "refused", retryable: true, layer: "tcp" },
    });
    expect(
      parsePreviewTunnelServerFrame(
        JSON.stringify({ type: "error", error: { category: "bogus", message: "x" } }),
      ),
    ).toBeNull();
  });

  test("reserved cookie names", () => {
    expect(isReservedPreviewCookieName("__Host-orkestrator-preview")).toBe(true);
    expect(isReservedPreviewCookieName("ORKESTRATOR_GATEWAY_AUTH")).toBe(true);
    expect(isReservedPreviewCookieName("__Host-session")).toBe(false);
  });
});

describe("browser tab targets", () => {
  test("service references round-trip through the durable URI", async () => {
    const { formatPreviewServiceUri, parsePreviewTabTarget } =
      await import("./preview-services.js");
    const ref = {
      backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
      environmentId: "env with/slash",
      serviceId: FIXTURE_SERVICE_ID,
      path: "/a?b=1#c",
    };
    const uri = formatPreviewServiceUri(ref);
    expect(uri).toStartWith("orkestrator-preview://service/");
    expect(parsePreviewTabTarget(uri)).toEqual({ kind: "service", ref });
  });

  test("intents and plain addresses are distinguished; malformed URIs stay unsupported addresses", async () => {
    const { formatPreviewIntentUri, parsePreviewTabTarget } = await import("./preview-services.js");
    const intent = formatPreviewIntentUri({
      environmentId: "env",
      source: "container-terminal",
      url: "http://localhost:3000/x?y=1",
    });
    expect(parsePreviewTabTarget(intent)).toEqual({
      kind: "intent",
      environmentId: "env",
      source: "container-terminal",
      url: "http://localhost:3000/x?y=1",
    });
    expect(parsePreviewTabTarget("http://localhost:3000/")).toEqual({
      kind: "url",
      url: "http://localhost:3000/",
    });
    expect(parsePreviewTabTarget("")).toEqual({ kind: "url", url: "" });
    expect(parsePreviewTabTarget("orkestrator-preview://service/x/y/z")).toEqual({
      kind: "url",
      url: "orkestrator-preview://service/x/y/z",
    });
    expect(parsePreviewTabTarget("orkestrator-preview://intent/env/rm-rf?url=x").kind).toBe("url");
  });
});
