import { describe, expect, test } from "bun:test";
import type { CommandHandoverPreview } from "@orkestrator/protocol/command-nodes";
import type { ConnectionSummary } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import { deviceOnlyMachines } from "./command-handover";

const preview: CommandHandoverPreview = {
  targetNodeId: "bk_target" as BackendId,
  targetName: "Target",
  targetRegistered: true,
  targetNodeIds: ["bk_known" as BackendId],
  candidates: [
    { nodeId: "bk_candidate" as BackendId, displayName: "Candidate", hasCredential: true },
  ],
  self: { nodeId: "bk_self" as BackendId, displayName: "Self", reachable: true },
};
function connection(
  id: string,
  nodeId: string,
  overrides: Partial<ConnectionSummary> = {},
): ConnectionSummary {
  return {
    id,
    backendId: nodeId as BackendId,
    name: id,
    kind: "remote",
    active: false,
    address: `https://${id}.test`,
    requiresToken: false,
    ...overrides,
  };
}

describe("device-only handover machines", () => {
  test("excludes target connection, self, target-owned and candidate identities", () => {
    const machines = deviceOnlyMachines(
      {
        activeConnectionId: "self",
        connections: [
          connection("target", "bk_different"),
          connection("target-alias", "bk_target"),
          connection("self", "bk_self"),
          connection("known", "bk_known"),
          connection("candidate", "bk_candidate"),
          connection("new", "bk_new", {
            nickname: " Saved name ",
            profile: { revision: 1, displayName: "Profile", colorToken: "rose", cached: false },
          }),
        ],
      },
      preview,
      "target",
    );
    expect(machines).toEqual([
      {
        key: "device:new",
        name: "Saved name",
        colorToken: "rose",
        from: "device",
        connectionId: "new",
      },
    ]);
  });
  test("rejects missing credentials and identity conflicts while choosing a usable alias once", () => {
    const machines = deviceOnlyMachines(
      {
        activeConnectionId: "self",
        connections: [
          connection("missing", "bk_same", { requiresToken: true }),
          connection("conflict", "bk_conflict", { identity: "conflict" }),
          connection("unknown", "bk_unknown", { backendId: undefined }),
          connection("usable", "bk_same"),
          connection("duplicate", "bk_same"),
        ],
      },
      preview,
      undefined,
    );
    expect(machines.map((machine) => machine.connectionId)).toEqual(["usable"]);
  });
});
