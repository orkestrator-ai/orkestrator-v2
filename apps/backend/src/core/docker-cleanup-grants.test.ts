import { describe, expect, test } from "bun:test";
import { DockerCleanupGrants, type DockerCleanupGrant } from "./docker-cleanup-grants.js";

function grant(expiresAt: number): DockerCleanupGrant {
  return {
    owner: "owner",
    expiresAt,
    containers: new Map(),
    volumes: new Set(),
    networks: new Set(),
  };
}

describe("DockerCleanupGrants", () => {
  test("taking at capacity preserves both the oldest and newer valid grants", () => {
    const grants = new DockerCleanupGrants();
    const entries = Array.from({ length: 8 }, () => grant(grants.expiryFrom(0)));
    entries.forEach((entry, index) => grants.record(String(index), entry, 0));
    expect(grants.take("missing", "owner", 1)).toBeUndefined();
    expect(grants.take("0", "other-owner", 1)).toBeUndefined();
    expect(grants.take("0", "owner", 1)).toBe(entries[0]);
    expect(grants.take("6", "owner", 1)).toBe(entries[6]);
    expect(grants.take("0", "owner", 1)).toBeUndefined();
  });

  test("a ninth record evicts only the oldest grant", () => {
    const grants = new DockerCleanupGrants();
    const entries = Array.from({ length: 9 }, () => grant(grants.expiryFrom(0)));
    entries.forEach((entry, index) => grants.record(String(index), entry, 0));
    expect(grants.take("0", "owner", 1)).toBeUndefined();
    for (let index = 1; index < 9; index += 1) {
      expect(grants.take(String(index), "owner", 1)).toBe(entries[index]);
    }
  });

  test("replacing a token at capacity does not evict another grant", () => {
    const grants = new DockerCleanupGrants();
    for (let index = 0; index < 8; index += 1) grants.record(String(index), grant(100), 0);
    const replacement = grant(200);
    grants.record("7", replacement, 1);
    expect(grants.take("0", "owner", 1)).toBeDefined();
    expect(grants.take("7", "owner", 1)).toBe(replacement);
  });

  test("expiry is exclusive and expired grants free capacity before eviction", () => {
    const grants = new DockerCleanupGrants();
    const expiry = grants.expiryFrom(0);
    expect(expiry).toBe(10 * 60_000);
    grants.record("valid", grant(expiry + 1), 0);
    for (let index = 0; index < 7; index += 1) grants.record(String(index), grant(expiry), 0);
    grants.record("new", grant(expiry + 2), expiry);
    expect(grants.take("0", "owner", expiry)).toBeUndefined();
    expect(grants.take("valid", "owner", expiry)).toBeDefined();
    expect(grants.take("new", "owner", expiry + 2)).toBeUndefined();
    grants.record("before", grant(expiry), 0);
    expect(grants.take("before", "owner", expiry - 1)).toBeDefined();
  });
});
