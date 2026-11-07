import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import {
  LEGACY_DOMAIN_VERSION,
  domainClient,
  pickVersion,
  type ApiOf,
  type CommandCall,
} from "./client.js";
import { defineCommand } from "./command.js";
import { defineDomain } from "./domain.js";

const environments = defineDomain({ name: "environments", version: 4, min: 3 });

const listEnvironments = defineCommand({
  domain: environments,
  name: "get_environments",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: Schema.Array(Schema.Struct({ id: Schema.String })),
  critical: [],
});

interface EnvironmentsApi {
  list(projectId: string): Promise<readonly string[]>;
}

const adapter =
  (tag: string) =>
  (call: CommandCall): EnvironmentsApi => ({
    list: async (projectId) =>
      (await call(listEnvironments, { projectId })).map((row) => `${tag}:${row.id}`),
  });

describe("pickVersion", () => {
  it("picks the highest client version inside an overlapping range", () => {
    expect(pickVersion([4, 3, 0], { min: 1, max: 4 })).toBe(4);
    expect(pickVersion([4, 3, 0], { min: 1, max: 3 })).toBe(3);
    expect(pickVersion([0, 3, 4], { min: 3, max: 9 })).toBe(4);
    expect(pickVersion(new Set([2, 5]), { min: 2, max: 2 })).toBe(2);
  });

  it("returns null when the ranges are disjoint", () => {
    expect(pickVersion([4, 3], { min: 5, max: 7 })).toBeNull();
    expect(pickVersion([4, 3], { min: 1, max: 2 })).toBeNull();
    expect(pickVersion([], { min: 1, max: 2 })).toBeNull();
  });

  it("treats a pre-contract node (no domains) as version 0 only", () => {
    expect(pickVersion([4, 3, 0], null)).toBe(LEGACY_DOMAIN_VERSION);
    expect(pickVersion([4, 3, 0], undefined)).toBe(0);
    expect(pickVersion([4, 3], null)).toBeNull();
    // A contract node never offers 0 unless its range starts there.
    expect(pickVersion([4, 0], { min: 1, max: 3 })).toBeNull();
  });
});

describe("domainClient", () => {
  it("orders versions highest first and builds the picked adapter", async () => {
    const client = domainClient(environments, {
      0: adapter("v0"),
      4: adapter("v4"),
      3: adapter("v3"),
    });
    expect(client.versions).toEqual([4, 3, 0]);
    expect(Object.isFrozen(client)).toBe(true);
    const version = pickVersion(client.versions, { min: 1, max: 3 });
    expect(version).toBe(3);
    const call: CommandCall = async (def, args) => {
      expect(def as unknown).toBe(listEnvironments);
      expect(args).toEqual({ projectId: "p" });
      return [{ id: "e1" }] as never;
    };
    const api: ApiOf<typeof client> = client.adapters[version as number]!(call, {} as never);
    expect(await api.list("p")).toEqual(["v3:e1"]);
  });

  it("refuses adapters outside 0..version and a missing current version", () => {
    expect(() => domainClient(environments, { 5: adapter("x"), 4: adapter("y") })).toThrow(
      /adapter versions/,
    );
    expect(() => domainClient(environments, { 1.5: adapter("x"), 4: adapter("y") })).toThrow(
      /adapter versions/,
    );
    expect(() => domainClient(environments, { 3: adapter("x") })).toThrow(/current version 4/);
  });
});
