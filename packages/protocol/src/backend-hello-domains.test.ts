import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  domainRange,
  isPreContract,
  MAX_HELLO_DOMAINS,
  parseBackendHello,
  parseHelloDomains,
} from "./backend-profile.js";
import { checkBackendRoute } from "./node/node-link/backend-hello.js";
import { captureLogs, type LogCapture } from "./testing/log-capture.js";

const profile = {
  revision: 3,
  displayName: "Mac mini",
  colorToken: "violet",
  updatedAt: "2026-11-07T00:00:00.000Z",
};

function hello(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    installationId: "bk_one",
    generation: "g1",
    appVersion: "2.40.0",
    clientApi: { minVersion: 1, maxVersion: 1 },
    capabilities: { "backend-profile": 1 },
    profile,
    endpointRole: "client",
    ...overrides,
  };
}

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

function malformedEvents() {
  return logs
    .records()
    .filter((record) => record.area === "contract" && record.event === "hello.domains-malformed");
}

describe("hello domains", () => {
  test("a valid domains field is kept, unknown domain names included", () => {
    const parsed = parseBackendHello(
      hello({
        domains: {
          "node-mail": { min: 1, max: 3 },
          "a-domain-from-the-future": { min: 0, max: 1000 },
        },
      }),
    );
    expect(parsed.domains).toEqual({
      "node-mail": { min: 1, max: 3 },
      "a-domain-from-the-future": { min: 0, max: 1000 },
    });
    expect(isPreContract(parsed)).toBe(false);
    expect(domainRange(parsed, "node-mail")).toEqual({ min: 1, max: 3 });
    expect(domainRange(parsed, "a-domain-from-the-future")).toEqual({ min: 0, max: 1000 });
    expect(domainRange(parsed, "ticket-sync")).toBeUndefined();
    expect(malformedEvents()).toHaveLength(0);
  });

  test("an empty domains object is a contract-aware backend with no domains yet", () => {
    const parsed = parseBackendHello(hello({ domains: {} }));
    expect(parsed.domains).toEqual({});
    expect(isPreContract(parsed)).toBe(false);
    expect(domainRange(parsed, "node-mail")).toBeUndefined();
  });

  test("an absent domains field is a pre-contract backend, without a log entry", () => {
    const parsed = parseBackendHello(hello());
    expect(parsed.domains).toBeUndefined();
    expect("domains" in parsed).toBe(false);
    expect(isPreContract(parsed)).toBe(true);
    expect(isPreContract(null)).toBe(true);
    expect(isPreContract(undefined)).toBe(true);
    expect(domainRange(parsed, "node-mail")).toBeUndefined();
    expect(domainRange(null, "node-mail")).toBeUndefined();
    expect(malformedEvents()).toHaveLength(0);
  });

  test("unknown keys inside a range are dropped", () => {
    const parsed = parseBackendHello(
      hello({ domains: { "node-mail": { min: 1, max: 2, preferred: 2 } } }),
    );
    expect(parsed.domains).toEqual({ "node-mail": { min: 1, max: 2 } });
  });

  const malformed: Array<[label: string, domains: unknown, reason: string]> = [
    ["null", null, "not-object"],
    ["an array", [{ min: 1, max: 1 }], "not-object"],
    ["a string", "node-mail", "not-object"],
    ["a capability-style number", { "node-mail": 1 }, "invalid-range"],
    ["a range that is null", { "node-mail": null }, "invalid-range"],
    ["a range that is an array", { "node-mail": [1, 2] }, "invalid-range"],
    ["min above max", { "node-mail": { min: 3, max: 2 } }, "invalid-range"],
    ["a missing max", { "node-mail": { min: 1 } }, "invalid-range"],
    ["a fractional version", { "node-mail": { min: 1.5, max: 2 } }, "invalid-range"],
    ["a string version", { "node-mail": { min: "1", max: 2 } }, "invalid-range"],
    ["a negative min", { "node-mail": { min: -1, max: 2 } }, "invalid-range"],
    ["a max above 1000", { "node-mail": { min: 1, max: 1001 } }, "invalid-range"],
    [
      "a non-finite max",
      { "node-mail": { min: 1, max: Number.POSITIVE_INFINITY } },
      "invalid-range",
    ],
    ["an upper-case name", { "Node-Mail": { min: 1, max: 1 } }, "invalid-name"],
    ["a name with a space", { "node mail": { min: 1, max: 1 } }, "invalid-name"],
    ["a name starting with a digit", { "1node": { min: 1, max: 1 } }, "invalid-name"],
    ["an empty name", { "": { min: 1, max: 1 } }, "invalid-name"],
    ["a 65-character name", { [`a${"b".repeat(64)}`]: { min: 1, max: 1 } }, "invalid-name"],
    ["a prototype key", JSON.parse('{"__proto__":{"min":1,"max":1}}'), "invalid-name"],
  ];
  for (const [label, domains, reason] of malformed) {
    test(`${label} drops the whole field and keeps the hello`, () => {
      const parsed = parseBackendHello(hello({ domains }));
      expect(parsed.domains).toBeUndefined();
      expect(isPreContract(parsed)).toBe(true);
      expect(parsed.installationId as string).toBe("bk_one");
      const events = malformedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.level).toBe("warn");
      // Content-free: the reason only, never a name or a value.
      expect(events[0]!.fields).toEqual({ reason });
    });
  }

  test("a valid entry next to a malformed one is not kept: the field is all or nothing", () => {
    const parsed = parseBackendHello(
      hello({ domains: { "node-mail": { min: 1, max: 1 }, "Bad Name": { min: 1, max: 1 } } }),
    );
    expect(parsed.domains).toBeUndefined();
  });

  test(`at most ${MAX_HELLO_DOMAINS} domains`, () => {
    const atBound = Object.fromEntries(
      Array.from({ length: MAX_HELLO_DOMAINS }, (_, index) => [`d${index}`, { min: 0, max: 1 }]),
    );
    expect(Object.keys(parseBackendHello(hello({ domains: atBound })).domains!)).toHaveLength(
      MAX_HELLO_DOMAINS,
    );
    const over = { ...atBound, overflow: { min: 0, max: 1 } };
    const parsed = parseBackendHello(hello({ domains: over }));
    expect(parsed.domains).toBeUndefined();
    expect(malformedEvents().map((record) => record.fields)).toEqual([{ reason: "too-many" }]);
  });

  test("domains never count against capabilities and never change the schema version", () => {
    const parsed = parseBackendHello(hello({ domains: { "node-mail": { min: 1, max: 1 } } }));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.capabilities).toEqual({ "backend-profile": 1 });
    // A hello with a newer schema version is still refused, domains or not.
    expect(() => parseBackendHello(hello({ schemaVersion: 2, domains: {} }))).toThrow();
  });

  test("domainRange reads own keys only", () => {
    const parsed = parseBackendHello(hello({ domains: {} }));
    expect(domainRange(parsed, "constructor")).toBeUndefined();
    expect(domainRange(parsed, "toString")).toBeUndefined();
    expect(domainRange(parsed, "__proto__")).toBeUndefined();
    const named = parseBackendHello(hello({ domains: { constructor: { min: 1, max: 2 } } }));
    expect(domainRange(named, "constructor")).toEqual({ min: 1, max: 2 });
  });

  test("parseHelloDomains reports the problem without throwing", () => {
    expect(parseHelloDomains({ git: { min: 1, max: 1 } })).toEqual({
      ok: true,
      domains: { git: { min: 1, max: 1 } },
    });
    expect(parseHelloDomains(undefined)).toEqual({ ok: false, problem: "not-object" });
  });
});

/**
 * Hellos from published releases, reconstructed from each tag's source (no
 * old binary was run): the gateway's `handleHello` and the identity
 * `backendHelloIdentity` returned, with this test's installation values.
 *
 * - v2.21.0 (the support floor until 2026-12-15, docs/architecture/
 *   version-compatibility.md) has no hello route at all. Its gateway serves
 *   the web client for an unknown `/__orkestrator/*` path
 *   (`gateway-auth.ts`, `this.proxy.serveStatic(...)` after the route
 *   chain: the SPA's HTML, or 404 when no web build is installed) and
 *   answers `/__orkestrator/status` with `{ ok: true }`.
 * - v2.25.0-alpha is the first published release with the hello
 *   (`gateway-auth.ts:558-582` at the tag): capabilities `backend-profile`,
 *   `summary-reads`, plus `node-attachment` in a node mode; no `buildCommit`.
 * - v2.36.0 is the first Stable release with the hello
 *   (`gateway-auth.ts:550-580` at the tag): a node mode adds
 *   `public-action-relay`, `node-mail-steer`, `node-coordinator-mail` and
 *   `ticket-sync`; no `buildCommit`.
 */
const RELEASE_HELLOS = {
  "v2.25.0-alpha": {
    schemaVersion: 1,
    installationId: "bk_7f3c2a9e-4b1d-4c8e-9a2f-1d5e6b7c8a90",
    generation: "gen_2c9d1e4f",
    appVersion: "2.25.0-alpha",
    clientApi: { minVersion: 1, maxVersion: 1 },
    capabilities: { "backend-profile": 1, "summary-reads": 1, "node-attachment": 1 },
    profile: {
      revision: 1,
      displayName: "Build box",
      colorToken: "teal",
      updatedAt: "2026-10-22T09:00:00.000Z",
    },
    endpointRole: "client",
    nodeMode: "leaf",
  },
  "v2.36.0": {
    schemaVersion: 1,
    installationId: "bk_7f3c2a9e-4b1d-4c8e-9a2f-1d5e6b7c8a90",
    generation: "gen_5a6b7c8d",
    appVersion: "2.36.0",
    clientApi: { minVersion: 1, maxVersion: 1 },
    capabilities: {
      "backend-profile": 1,
      "summary-reads": 1,
      "loopback-client-gateway": 1,
      "node-attachment": 1,
      "public-action-relay": 1,
      "node-mail-steer": 1,
      "node-coordinator-mail": 1,
      "ticket-sync": 1,
    },
    profile: {
      revision: 4,
      displayName: "Build box",
      colorToken: "teal",
      updatedAt: "2026-11-01T09:00:00.000Z",
    },
    endpointRole: "client",
    nodeMode: "leaf",
  },
} as const;

describe("hellos from published releases", () => {
  for (const [release, json] of Object.entries(RELEASE_HELLOS)) {
    test(`${release} still parses, as a pre-contract backend`, () => {
      const parsed = parseBackendHello(JSON.parse(JSON.stringify(json)));
      expect(parsed.appVersion).toBe(json.appVersion);
      expect(parsed.capabilities).toEqual(json.capabilities);
      expect(parsed.nodeMode).toBe("leaf");
      expect(parsed.domains).toBeUndefined();
      expect(isPreContract(parsed)).toBe(true);
      expect(domainRange(parsed, "node-mail")).toBeUndefined();
      expect(malformedEvents()).toHaveLength(0);
    });
  }

  for (const [label, response] of [
    ["the web client's HTML", () => new Response("<!doctype html><html></html>", { status: 200 })],
    ["404 without a web build", () => new Response("Not found", { status: 404 })],
  ] as const) {
    test(`the floor release v2.21.0 (hello answered by ${label}) is a legacy, pre-contract backend`, async () => {
      const seen: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        seen.push(path);
        if (path === "/__orkestrator/status") return Response.json({ ok: true });
        return response();
      }) as typeof fetch;
      const outcome = await checkBackendRoute("https://floor.test", "token", {
        timeoutMs: 5_000,
        fetchImpl,
      });
      expect(outcome.kind).toBe("legacy");
      expect(seen).toEqual(["/__orkestrator/hello", "/__orkestrator/status"]);
      expect(isPreContract(outcome.kind === "hello" ? outcome.hello : null)).toBe(true);
    });
  }
});
