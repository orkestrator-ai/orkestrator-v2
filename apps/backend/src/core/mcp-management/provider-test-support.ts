/**
 * Shared add → update → rename → remove round trip for provider adapter
 * tests. Every step goes through the service, so each one is conflict
 * checked and verified exactly as a user's edit would be.
 */

import { expect } from "bun:test";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { SENTINEL, entry, mutation, revision, targetIdFor, type Fixture } from "./test-support.js";

export interface CrudOptions {
  kind?: "backend" | "environment";
  /** Project files refuse new literal secrets, so project round trips use a reference. */
  envValue?: string;
  targetId?: string;
}

export async function crud(
  fixture: Fixture,
  provider: AgentPlatform,
  sourceId: string,
  options: CrudOptions = {},
) {
  const targetId =
    options.targetId ?? (await targetIdFor(fixture, provider, options.kind ?? "backend"));
  const envValue = options.envValue ?? SENTINEL;
  const snap = () => fixture.service.snapshot({ targetId });
  let snapshot = await snap();
  await fixture.service.mutate(
    mutation(targetId, {
      kind: "add",
      sourceId,
      expectedRevision: revision(snapshot, sourceId),
      definition: {
        name: "fixture-a",
        transport: "stdio",
        command: "/opt/My Tools/server",
        args: ["--flag", "a b;c"],
        env: [{ key: "API_KEY", value: envValue }],
      },
    }),
  );
  snapshot = await snap();
  await fixture.service.mutate(
    mutation(targetId, {
      kind: "update",
      entryId: entry(snapshot, sourceId, "fixture-a").entryId,
      expectedRevision: revision(snapshot, sourceId)!,
      patch: {
        args: [
          { kind: "keep", index: 0 },
          { kind: "set", value: "second" },
        ],
      },
    }),
  );
  snapshot = await snap();
  await fixture.service.mutate(
    mutation(targetId, {
      kind: "rename",
      entryId: entry(snapshot, sourceId, "fixture-a").entryId,
      expectedRevision: revision(snapshot, sourceId)!,
      newName: "fixture-b",
    }),
  );
  snapshot = await snap();
  expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
  const renamed = entry(snapshot, sourceId, "fixture-b");
  expect(renamed.command).toEqual({ kind: "visible", value: "/opt/My Tools/server" });
  expect(renamed.argCount).toBe(2);
  expect(() => entry(snapshot, sourceId, "fixture-a")).toThrow();
  return {
    targetId,
    snapshot,
    renamed,
    remove: async () => {
      const latest = await snap();
      await fixture.service.mutate(
        mutation(targetId, {
          kind: "remove",
          entryId: entry(latest, sourceId, "fixture-b").entryId,
          expectedRevision: revision(latest, sourceId)!,
        }),
      );
      const after = await snap();
      expect(after.definitions.some((row) => row.sourceId === sourceId)).toBe(
        after.definitions.some((row) => row.sourceId === sourceId && row.name !== "fixture-b"),
      );
      expect(() => entry(after, sourceId, "fixture-b")).toThrow();
    },
  };
}
