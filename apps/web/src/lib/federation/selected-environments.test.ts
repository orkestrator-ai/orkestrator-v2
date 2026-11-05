import { describe, expect, test } from "bun:test";
import { environmentKey, environmentRef, type BackendId } from "@orkestrator/protocol/federation";
import type { Environment } from "@/types";
import type { MachineView } from "./aggregate";
import {
  isSelectedEnvironmentReachable,
  isSelectedEnvironmentRunning,
  resolveSelectedEnvironments,
} from "./selected-environments";
import type { FederatedEnvironment } from "./summaries";

const local = (id: string, extra: Partial<Environment> = {}) =>
  ({ id, name: `Own ${id}`, status: "running", environmentType: "local", ...extra }) as Environment;

function machine(
  id: string,
  environments: Array<{ id: string; extra?: Partial<FederatedEnvironment> }>,
  transport: MachineView["transport"] = "connected",
): MachineView {
  const backendId = `bk_${id}` as BackendId;
  return {
    connectionId: backendId,
    backendId,
    name: `Machine ${id}`,
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport,
    projects: [],
    environmentsByProject: new Map([
      [
        "p",
        environments.map(({ id: environmentId, extra }) => {
          const ref = environmentRef(backendId, environmentId);
          return {
            ref,
            key: environmentKey(ref),
            projectId: "p",
            name: `${environmentId} on ${id}`,
            status: "running",
            environmentType: "containerized",
            ...extra,
          } as FederatedEnvironment;
        }),
      ],
    ]),
    truncated: false,
    loadedAt: 1,
  };
}

const key = (machineId: string, id: string) =>
  environmentKey(environmentRef(`bk_${machineId}` as BackendId, id));

describe("resolveSelectedEnvironments", () => {
  test("finds each row on its own machine, keeping selection order", () => {
    const machines = [machine("a", [{ id: "same" }]), machine("b", [{ id: "same" }])];
    const resolved = resolveSelectedEnvironments(
      [key("b", "same"), "same", key("a", "same")],
      [local("same")],
      machines,
    );
    expect(resolved.map((entry) => entry.name)).toEqual(["same on b", "Own same", "same on a"]);
    expect(
      resolved.map((entry) => (entry.remote?.ref.backendId as string | undefined) ?? null),
    ).toEqual(["bk_b", null, "bk_a"]);
  });

  test("excludes deleting rows even if their last reported status is running", () => {
    expect(
      resolveSelectedEnvironments(
        ["requested", "deleting", key("a", "removing"), key("a", "ready")],
        [
          local("requested", { deletionRequestedAt: "2026-11-05T00:00:00Z" }),
          local("deleting", { lifecycleOperation: "deleting" }),
        ],
        [machine("a", [{ id: "removing", extra: { deleting: true } }, { id: "ready" }])],
      ).map((entry) => entry.selectionId),
    ).toEqual([key("a", "ready")]);
  });

  test("drops rows that no longer exist on any machine", () => {
    expect(
      resolveSelectedEnvironments(
        ["gone", key("a", "gone"), key("unknown", "x")],
        [local("here")],
        [machine("a", [{ id: "other" }])],
      ),
    ).toEqual([]);
  });
});

describe("what a selected environment can take", () => {
  test("a machine must be connected to take writes", () => {
    const [up] = resolveSelectedEnvironments([key("a", "e")], [], [machine("a", [{ id: "e" }])]);
    const [down] = resolveSelectedEnvironments(
      [key("a", "e")],
      [],
      [machine("a", [{ id: "e" }], "unreachable")],
    );
    const [own] = resolveSelectedEnvironments(["o"], [local("o")], []);
    expect(isSelectedEnvironmentReachable(up!)).toBe(true);
    expect(isSelectedEnvironmentReachable(down!)).toBe(false);
    expect(isSelectedEnvironmentReachable(own!)).toBe(true);
  });

  test("Docker is judged on the machine that owns the container", () => {
    const [remoteNoDocker] = resolveSelectedEnvironments(
      [key("a", "e")],
      [],
      [machine("a", [{ id: "e", extra: { dockerAvailable: false } }])],
    );
    const [remoteUnknown] = resolveSelectedEnvironments(
      [key("a", "e")],
      [],
      [machine("a", [{ id: "e" }])],
    );
    const [ownContainer] = resolveSelectedEnvironments(
      ["o"],
      [local("o", { environmentType: "containerized" })],
      [],
    );
    // This window's Docker says nothing about another machine's container.
    expect(isSelectedEnvironmentRunning(remoteNoDocker!, true)).toBe(false);
    expect(isSelectedEnvironmentRunning(remoteUnknown!, false)).toBe(true);
    expect(isSelectedEnvironmentRunning(ownContainer!, false)).toBe(false);
    expect(isSelectedEnvironmentRunning(ownContainer!, true)).toBe(true);
  });

  test("a stopped environment is not running", () => {
    const [stopped] = resolveSelectedEnvironments(["o"], [local("o", { status: "stopped" })], []);
    expect(isSelectedEnvironmentRunning(stopped!, true)).toBe(false);
  });
});
