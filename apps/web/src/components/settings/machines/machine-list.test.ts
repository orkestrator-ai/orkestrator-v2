import { describe, expect, test } from "bun:test";
import type { NodeListResult, NodeStatus, NodeView } from "@orkestrator/protocol/command-nodes";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { buildMachineList, maintenanceIssues } from "./machine-list";

const status: NodeStatus = {
  nodeId: "bk_self" as never,
  mode: "command",
  registrationEnabled: true,
  controllers: [],
  detachedControllers: [],
  suspendedSubordinateCount: 0,
};

function node(id: string, name: string, overrides: Partial<NodeView> = {}): NodeView {
  return {
    nodeId: `bk_${id}` as never,
    enabled: true,
    displayName: name,
    colorToken: "teal",
    fallbackName: id,
    routes: [
      {
        id: "https" as never,
        kind: "https",
        enabled: true,
        origin: `https://${id}.tailnet.ts.net`,
      },
    ],
    routeOrder: ["https" as never],
    hasCredential: true,
    attachment: { status: "attached" },
    connection: { state: "connected", epoch: 1, activeRouteId: "https" as never },
    addedAt: "2026-10-21T00:00:00.000Z",
    lastConnectedAt: "2026-10-21T10:00:00.000Z",
    source: "portal",
    ...overrides,
  };
}

function nodes(...views: NodeView[]): NodeListResult {
  return { revision: 1, mode: "command", suspended: false, nodes: views, pendingDetaches: [] };
}

const local: ConnectionSummary = {
  id: "local",
  name: "Local",
  address: null,
  kind: "local",
  active: true,
  requiresToken: false,
  backendId: "bk_self" as never,
};

function remote(id: string, overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id,
    name: `${id}.example`,
    address: `https://${id}.example`,
    kind: "remote",
    active: false,
    requiresToken: false,
    transport: "disabled",
    ...overrides,
  };
}

function list(...connections: ConnectionSummary[]): ConnectionList {
  return { activeConnectionId: "local", connections };
}

describe("buildMachineList", () => {
  test("lists the command node first, then the rest in registry order, each once", () => {
    const entries = buildMachineList({
      status,
      nodes: nodes(node("zed", "Zed"), node("build", "Build box")),
      connections: list(local, remote("build", { backendId: "bk_build" as never })),
      selfProfile: { revision: 1, displayName: "Desk", colorToken: "violet", updatedAt: "t" },
      workspaceNodeId: null,
    });
    expect(entries.map((entry) => [entry.name, entry.role, entry.current])).toEqual([
      ["Desk", "self", true],
      ["Zed", "node", false],
      ["Build box", "node", false],
    ]);
    const build = entries[2]!;
    // The saved connection to the same installation is merged into the node.
    expect(build.connection?.id).toBe("build");
    expect(build.address).toBe("build.tailnet.ts.net");
    expect(build.via).toBe("Tailscale HTTPS");
    expect(build.connected).toBe(true);
    expect(build.maintenance).toBe(true);
    expect(entries[0]!.address).toBe("This device");
    expect(entries[0]!.via).toBe("Local backend on this device");
  });

  test("a machine is listed once however many ways it is saved or reached", () => {
    // The window is on mini, a remote command node; mbp3 is this device (Local) and
    // also saved at its Tailscale address without a proved identity.
    const entries = buildMachineList({
      status: { ...status, nodeId: "bk_mini" as never },
      nodes: nodes(node("mbp3", "mbp3"), node("gram", "omarchy-gram")),
      connections: {
        activeConnectionId: "mini",
        connections: [
          { ...local, active: false, backendId: "bk_mbp3" as never },
          remote("mini", {
            active: true,
            backendId: "bk_mini" as never,
            address: "https://mini.tailnet.ts.net",
          }),
          remote("mini-again", { address: "https://mini.tailnet.ts.net" }),
          remote("mbp3-tailnet", { address: "https://mbp3.tailnet.ts.net" }),
          remote("gram", { address: "https://gram.tailnet.ts.net" }),
          remote("hp", { address: "https://hp.tailnet.ts.net", backendId: "bk_hp" as never }),
          remote("hp-ssh", { address: null, backendId: "bk_hp" as never }),
        ],
      },
      selfProfile: { revision: 1, displayName: "mini", colorToken: "violet", updatedAt: "t" },
      workspaceNodeId: null,
    });
    expect(entries.map((entry) => [entry.name, entry.role])).toEqual([
      ["mini", "self"],
      ["mbp3", "node"],
      ["omarchy-gram", "node"],
      ["hp.example", "device"],
    ]);
    // The node keeps the saved connection with its proved identity.
    expect(entries.find((entry) => entry.name === "mbp3")?.connection?.id).toBe("local");
  });

  test("the node the window's workspace is on is the current machine but does not move", () => {
    const entries = buildMachineList({
      status,
      nodes: nodes(node("build", "Build box")),
      connections: null,
      selfProfile: null,
      workspaceNodeId: "bk_build",
    });
    expect(entries.map((entry) => [entry.name, entry.current])).toEqual([
      ["This machine", false],
      ["Build box", true],
    ]);
  });

  test("the machines follow the stored order, under the command node wherever it is stored", () => {
    const entries = buildMachineList({
      status,
      nodes: nodes(node("a", "A"), node("b", "B"), node("c", "C"), node("new", "New")),
      connections: list(local, remote("vps")),
      selfProfile: null,
      workspaceNodeId: null,
      machineOrder: ["bk_c", "bk_self", "bk_a", "bk_gone", "bk_b"],
    });
    expect(entries.map((entry) => entry.nodeId ?? entry.role)).toEqual([
      "bk_self",
      "bk_c",
      // A new machine follows the one before it in the registry, as in the sidebar.
      "bk_new",
      "bk_a",
      "bk_b",
      "device",
    ]);
  });

  test("describes unreachable nodes, SSH routes and machines saved on this device only", () => {
    const entries = buildMachineList({
      status,
      nodes: nodes(
        node("ssh", "Tunnel", {
          routes: [
            {
              id: "ssh" as never,
              kind: "ssh",
              enabled: true,
              destination: "tunnel-host",
              remoteGatewayPort: 34122,
            },
          ],
          routeOrder: ["ssh" as never],
          connection: { state: "unavailable", epoch: 1 },
        }),
      ),
      connections: list(local, remote("vps", { transport: "connected" })),
      selfProfile: null,
      workspaceNodeId: null,
    });
    const tunnel = entries.find((entry) => entry.name === "Tunnel")!;
    expect(tunnel).toMatchObject({
      address: "tunnel-host",
      via: "SSH tunnel",
      connected: false,
      statusText: "Unavailable",
      maintenance: false,
    });
    const vps = entries.find((entry) => entry.role === "device")!;
    expect(vps).toMatchObject({
      name: "vps.example",
      address: "vps.example",
      via: "HTTPS",
      connected: true,
      maintenance: false,
    });
  });

  test("a browser client lists the machine it reached at its own address", () => {
    const [self] = buildMachineList({
      status,
      nodes: nodes(),
      connections: null,
      selfProfile: null,
      workspaceNodeId: null,
      selfAddress: "desk.tailnet.ts.net",
    });
    expect(self).toMatchObject({ role: "self", address: "desk.tailnet.ts.net", connected: true });
  });
});

describe("maintenanceIssues", () => {
  test("nothing is reported for a current machine", () => {
    expect(maintenanceIssues(hostMaintenanceSnapshotFixture())).toEqual([]);
  });

  test("an Orkestrator update, tools needing repair and an incompatible image are issues", () => {
    const issues = maintenanceIssues(
      hostMaintenanceSnapshotFixture({
        updater: {
          ...hostMaintenanceSnapshotFixture().updater,
          latestVersion: "2.27.0",
          updateAvailable: true,
        },
        tools: [
          { name: "claude", pinnedVersion: "2.1.3", source: "managed", installedVersion: "2.1.3" },
          { name: "codex", pinnedVersion: "0.9.0", source: "missing", installedVersion: null },
          { name: "pi", pinnedVersion: "1.0.0", source: "path", installedVersion: null },
          {
            name: "opencode",
            pinnedVersion: "1.2.0",
            source: "managed",
            installedVersion: "1.1.0",
          },
          {
            name: "gh",
            pinnedVersion: "2.0.0",
            source: "managed",
            installedVersion: "2.5.0",
            channel: "latest",
          },
        ],
        image: {
          name: "orkestrator-v2:latest",
          present: true,
          compatible: false,
          reason: null,
          releaseReference: "ghcr.io/x:2.26.0",
          outdatedEnvironments: [],
        },
      }),
    );
    expect(issues).toEqual([
      "Orkestrator 2.27.0 is available",
      "codex is missing",
      "pi is not managed by Orkestrator",
      "opencode 1.1.0 differs from 1.2.0",
      "The container image is out of date",
    ]);
  });

  test("a missing image or unreachable Docker is not an update", () => {
    const base = {
      name: "orkestrator-v2:latest",
      compatible: null,
      reason: null,
      releaseReference: "ghcr.io/x:2.26.0",
      outdatedEnvironments: [],
    };
    expect(
      maintenanceIssues(hostMaintenanceSnapshotFixture({ image: { ...base, present: false } })),
    ).toEqual([]);
    expect(maintenanceIssues(hostMaintenanceSnapshotFixture({ image: null }))).toEqual([]);
  });
});

test("browser discovery failure retains a self entry even without profile metadata", () => {
  for (const selfProfile of [
    null,
    { revision: 1, displayName: "Desk", colorToken: "teal", updatedAt: "t" },
  ]) {
    const [self] = buildMachineList({
      status: null,
      nodes: null,
      connections: null,
      selfProfile,
      workspaceNodeId: null,
      selfAddress: "desk.example",
    });
    expect(self).toMatchObject({
      role: "self",
      current: true,
      connected: true,
      maintenance: true,
      address: "desk.example",
    });
  }
});

test("nonempty saved nicknames take precedence for self, registered and device-only machines", () => {
  const profile = {
    revision: 1,
    displayName: "Canonical",
    colorToken: "teal",
    updatedAt: "t",
    cached: true,
  };
  for (const nickname of ["My name", "", "   ", undefined]) {
    const entries = buildMachineList({
      status,
      nodes: nodes(node("build", "Canonical")),
      connections: list(
        { ...local, nickname },
        remote("build", { backendId: "bk_build" as never, profile, nickname }),
        remote("other", { profile, nickname }),
      ),
      selfProfile: profile,
      workspaceNodeId: null,
    });
    expect(entries.map((e) => e.name)).toEqual(Array(3).fill(nickname?.trim() || "Canonical"));
  }
});

test("device-only aliases prefer the saved connection with credentials", () => {
  const entries = buildMachineList({
    status,
    nodes: nodes(),
    workspaceNodeId: null,
    connections: list(
      local,
      remote("missing", { backendId: "bk_same" as never, requiresToken: true }),
      remote("usable", { backendId: "bk_same" as never, requiresToken: false }),
    ),
    selfProfile: { revision: 1, displayName: "Desk", colorToken: "violet", updatedAt: "t" },
  });
  const devices = entries.filter((entry) => entry.role === "device");
  expect(devices).toHaveLength(1);
  expect(devices[0]?.connection?.id).toBe("usable");
  expect(devices[0]?.connection?.requiresToken).toBe(false);
});
