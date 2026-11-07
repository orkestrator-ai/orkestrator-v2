import { describe, expect, it } from "bun:test";
import {
  DOMAIN_NAMES,
  DOMAIN_NAME_PATTERN,
  MAX_DOMAIN_NAME_LENGTH,
  defineDomain,
  isDomainName,
  isDomainNameShape,
  type DomainName,
} from "./domain.js";

describe("DOMAIN_NAMES", () => {
  it("passes the hello capability name pattern and length bound", () => {
    for (const name of DOMAIN_NAMES) {
      // The pattern parseBackendHello applies to capability names.
      expect(/^[a-z][a-z0-9-]*$/.test(name)).toBe(true);
      expect(DOMAIN_NAME_PATTERN.test(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(MAX_DOMAIN_NAME_LENGTH);
      expect(isDomainNameShape(name)).toBe(true);
      expect(isDomainName(name)).toBe(true);
    }
  });

  it("has no duplicates and fits the hello's 64-domain bound", () => {
    expect(new Set(DOMAIN_NAMES).size).toBe(DOMAIN_NAMES.length);
    expect(DOMAIN_NAMES.length).toBeLessThanOrEqual(64);
  });
});

describe("isDomainNameShape", () => {
  it("accepts unknown names of the right shape and refuses others", () => {
    expect(isDomainNameShape("future-domain")).toBe(true);
    expect(isDomainName("future-domain")).toBe(false);
    for (const value of ["", "Env", "1env", "env_x", "env.x", "a".repeat(65), 3, null]) {
      expect(isDomainNameShape(value)).toBe(false);
    }
  });
});

describe("defineDomain", () => {
  it("returns a frozen definition whose min defaults to its version", () => {
    const domain = defineDomain({ name: "environments", version: 4 });
    expect(domain).toEqual({ kind: "domain", name: "environments", version: 4, min: 4 });
    expect(Object.isFrozen(domain)).toBe(true);
    expect(defineDomain({ name: "node-mail", version: 3, min: 1 }).min).toBe(1);
  });

  it("refuses unknown names and invalid ranges", () => {
    expect(() => defineDomain({ name: "nope" as DomainName, version: 1 })).toThrow(/DOMAIN_NAMES/);
    for (const range of [
      { version: 0 },
      { version: 1.5 },
      { version: 1_001 },
      { version: 2, min: 3 },
      { version: 2, min: 0 },
    ]) {
      expect(() => defineDomain({ name: "git", ...range })).toThrow(/invalid version range/);
    }
  });
});
