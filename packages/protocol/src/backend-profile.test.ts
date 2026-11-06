import { describe, expect, test } from "bun:test";
import {
  CLIENT_API_VERSION,
  defaultMachineColor,
  FALLBACK_MACHINE_COLOR,
  hasBackendCapability,
  isClientApiCompatible,
  machineColorForDisplay,
  MACHINE_COLOR_TOKENS,
  normalizeMachineDisplayName,
  parseBackendHello,
  parseBackendProfile,
  parseBackendProfileUpdate,
} from "./backend-profile.js";

const profile = { revision: 3, displayName: "Mac mini", colorToken: "violet", updatedAt: "t" };

function hello(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    installationId: "bk_one",
    generation: "g1",
    appVersion: "2.24.0",
    clientApi: { minVersion: 1, maxVersion: 1 },
    capabilities: { "backend-profile": 1 },
    profile,
    endpointRole: "client",
    ...overrides,
  };
}

describe("machine colours", () => {
  test("the default colour is deterministic per installation", () => {
    expect(defaultMachineColor("bk_one")).toBe(defaultMachineColor("bk_one"));
    expect(MACHINE_COLOR_TOKENS).toContain(defaultMachineColor("bk_two"));
    const spread = new Set(
      Array.from({ length: 40 }, (_, index) => defaultMachineColor(`bk_${index}`)),
    );
    expect(spread.size).toBeGreaterThan(3);
  });

  test("an unknown future token renders as the neutral fallback without being rejected", () => {
    expect(parseBackendProfile({ ...profile, colorToken: "ultraviolet" }).colorToken).toBe(
      "ultraviolet",
    );
    expect(machineColorForDisplay("ultraviolet")).toBe(FALLBACK_MACHINE_COLOR);
    expect(machineColorForDisplay("teal")).toBe("teal");
  });

  test("a colour token is never arbitrary CSS", () => {
    for (const colorToken of ["#ff0000", "red;background:url(x)", "", "A"]) {
      expect(() => parseBackendProfile({ ...profile, colorToken })).toThrow();
    }
  });
});

describe("machine names", () => {
  test("strip control and bidi characters and collapse whitespace", () => {
    expect(normalizeMachineDisplayName("  Mac\u0007   mini‮ ")).toBe("Mac mini");
    expect(normalizeMachineDisplayName("   ")).toBeUndefined();
    expect(() => normalizeMachineDisplayName("x".repeat(65))).toThrow();
  });
});

describe("profile updates", () => {
  test("require an expected revision and a real change", () => {
    expect(parseBackendProfileUpdate({ expectedRevision: 2, colorToken: "teal" })).toEqual({
      expectedRevision: 2,
      colorToken: "teal",
    });
    expect(() => parseBackendProfileUpdate({ colorToken: "teal" })).toThrow();
    expect(() => parseBackendProfileUpdate({ expectedRevision: 2 })).toThrow();
    expect(() => parseBackendProfileUpdate({ expectedRevision: 2, colorToken: "#fff" })).toThrow();
    expect(() =>
      parseBackendProfileUpdate({ expectedRevision: 2, colorToken: "teal", extra: true }),
    ).toThrow();
  });
});

describe("backend hello", () => {
  test("parses a valid hello", () => {
    const parsed = parseBackendHello(hello());
    expect(parsed.installationId as string).toBe("bk_one");
    expect(parsed.endpointRole).toBe("client");
    expect(isClientApiCompatible(parsed)).toBe(true);
    expect(hasBackendCapability(parsed, "backend-profile")).toBe(true);
    expect(hasBackendCapability(parsed, "missing")).toBe(false);
    expect(hasBackendCapability(null, "backend-profile")).toBe(false);
  });

  test("rejects malformed identity, roles, capability floods and ranges", () => {
    expect(() => parseBackendHello(hello({ installationId: "" }))).toThrow();
    expect(() => parseBackendHello(hello({ endpointRole: "admin" }))).toThrow();
    expect(() => parseBackendHello(hello({ schemaVersion: 2 }))).toThrow();
    expect(() =>
      parseBackendHello(hello({ clientApi: { minVersion: 3, maxVersion: 2 } })),
    ).toThrow();
    const flood = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`cap-${i}`, 1]));
    expect(() => parseBackendHello(hello({ capabilities: flood }))).toThrow();
    expect(() => parseBackendHello(hello({ capabilities: { "Bad Name": 1 } }))).toThrow();
  });

  test("keeps a valid build commit, abbreviated or full", () => {
    for (const commit of ["abc1234", "0123456789abcdef0123456789abcdef01234567"]) {
      expect(parseBackendHello(hello({ buildCommit: commit })).buildCommit).toBe(commit);
    }
  });

  test("a hello without a build commit has none", () => {
    const parsed = parseBackendHello(hello());
    expect(parsed.buildCommit).toBeUndefined();
    expect("buildCommit" in parsed).toBe(false);
  });

  test("drops an invalid build commit and still accepts the hello", () => {
    for (const buildCommit of [
      "",
      "abc123",
      "ABC1234",
      "abc1234-dirty",
      "abc1234\n",
      "g".repeat(40),
      "a".repeat(41),
      1234567,
      null,
      { commit: "abc1234" },
    ]) {
      const parsed = parseBackendHello(hello({ buildCommit }));
      expect(parsed.installationId as string).toBe("bk_one");
      expect("buildCommit" in parsed).toBe(false);
    }
  });

  test("a backend outside the client API range is incompatible", () => {
    const parsed = parseBackendHello(
      hello({ clientApi: { minVersion: CLIENT_API_VERSION + 1, maxVersion: 9 } }),
    );
    expect(isClientApiCompatible(parsed)).toBe(false);
  });
});
