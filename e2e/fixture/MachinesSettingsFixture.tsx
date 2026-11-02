import { useEffect, useState } from "react";
import { FederationProvider } from "../../apps/web/src/components/federation/FederationProvider";
import { MachineCpuReadings } from "../../apps/web/src/components/federation/MachineCpuReadings";
import { AppDialogHost } from "../../apps/web/src/components/layout/AppDialogHost";
import { SystemUsageIndicator } from "../../apps/web/src/components/layout/SystemUsageIndicator";
import { portalStore } from "../../apps/web/src/lib/portal/portal-store";
import { onGlobalSettingsCloseRequest } from "../../apps/web/src/lib/settings-navigation";
import { useAppDialogStore } from "../../apps/web/src/stores/appDialogStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import type { Environment } from "../../apps/web/src/types";
import type { ConnectionList, ConnectToRemoteInput } from "@orkestrator/protocol/connections";
import { FullscreenSettingsLayout } from "../../apps/web/src/components/settings/FullscreenSettingsLayout";
import { MachinesSettings } from "../../apps/web/src/components/settings/machines/MachinesSettings";

const rebuildMode = new URLSearchParams(window.location.search).has("rebuild");
const oldEnvironment = {
  id: "old-environment",
  projectId: "project",
  name: "Old environment",
  order: 0,
  environmentType: "containerized",
  status: "stopped",
  containerId: "old-container",
  networkAccessMode: "restricted",
  createdAt: "2026-10-26T00:00:00Z",
} as Environment;

const connections: ConnectionList = {
  activeConnectionId: "local",
  credentialStorage: "secure",
  connections: [
    {
      id: "local",
      name: "Local",
      address: null,
      kind: "local",
      active: true,
      requiresToken: false,
      backendId: "bk_self" as never,
    },
    {
      id: "desk",
      name: "desk.tailnet.ts.net",
      address: "https://desk.tailnet.ts.net",
      kind: "remote",
      active: false,
      requiresToken: false,
      backendId: "bk_desk" as never,
      identity: "verified",
      transport: "disabled",
      lastConnectedAt: "2026-10-21T12:00:00.000Z",
    },
  ],
};

const deskNode = {
  nodeId: "bk_desk",
  enabled: true,
  displayName:
    new URLSearchParams(window.location.search).get("machineName") ??
    "Desk with a rather long machine name",
  colorToken: "teal",
  fallbackName: "desk",
  routes: [{ id: "https", kind: "https", enabled: true, origin: "https://desk.tailnet.ts.net" }],
  routeOrder: ["https"],
  hasCredential: true,
  attachment: { status: "attached" },
  connection: { state: "connected", epoch: 1, activeRouteId: "https", activeRouteKind: "https" },
  addedAt: "2026-10-21T00:00:00.000Z",
  lastConnectedAt: "2026-10-21T12:00:00.000Z",
  source: "portal",
};

// `?fleet`: a command node with several machines, for ordering and the CPU readings.
const fleetMode = new URLSearchParams(window.location.search).has("fleet");
const FLEET_CPU: Record<string, number> = {
  bk_self: 45,
  bk_build: 12,
  bk_laptop: 3,
  bk_rack: 80,
  bk_spare: 27,
};
const fleetNodes = (
  [
    ["build", "Build box", "blue", "connected"],
    ["laptop", "Laptop", "amber", "connected"],
    ["rack", "Rack", "orange", "connected"],
    ["spare", "Spare", "rose", "connected"],
    ["attic", "Attic", "slate", "unavailable"],
  ] as const
).map(([id, displayName, colorToken, state]) => ({
  ...deskNode,
  nodeId: `bk_${id}`,
  displayName,
  colorToken,
  fallbackName: id,
  routes: [{ ...deskNode.routes[0]!, origin: `https://${id}.tailnet.ts.net` }],
  connection: { ...deskNode.connection, state },
}));
let fleetMachineOrder: string[] = [];

function usageSample(nodeId: string) {
  return {
    cpuPercent: FLEET_CPU[nodeId],
    ramPercent: 58,
    gpuPercent: 8,
    diskPercent: 70,
    sampledAt: new Date().toISOString(),
  };
}

function snapshot(version: string, latestVersion: string | null) {
  return {
    revision: 1,
    version,
    updater: {
      kind: "desktop",
      available: true,
      reason: null,
      latestVersion,
      updateAvailable: latestVersion !== null && latestVersion !== version,
      checkedAt: "2026-10-21T12:00:00.000Z",
      checkError: null,
    },
    checkRequest: null,
    job: null,
    tasks: {},
    nextRelease: null,
    ghChannel: "pinned",
    updateChannel: "stable",
    tools: [
      { name: "claude", pinnedVersion: "2.1.3", source: "managed", installedVersion: "2.1.3" },
    ],
    image: rebuildMode
      ? {
          name: "orkestrator-v2:latest",
          present: true,
          compatible: true,
          reason: null,
          releaseReference: "old",
          outdatedEnvironments: [
            {
              id: oldEnvironment.id,
              name: oldEnvironment.name,
              projectId: oldEnvironment.projectId,
            },
          ],
        }
      : null,
  };
}

function routed(command: string, nodeId: string): unknown {
  if (command === "get_system_usage") return usageSample(nodeId);
  if (command === "get_host_maintenance") return snapshot("2.25.0", "2.26.0");
  if (command === "get_backend_profile") {
    return { revision: 2, displayName: deskNode.displayName, colorToken: "teal", updatedAt: "t" };
  }
  return { ok: true };
}

function hostAccounts() {
  return {
    accounts: ["claude", "codex"].map((platform) => ({
      id: "default",
      platform,
      label: new URLSearchParams(window.location.search).has("accountLayout")
        ? "Engineering production account — developer@long-company-name.example"
        : "Host login",
      isDefault: true,
      isActive: true,
      signedIn: true,
      identity: {},
    })),
    active: { claude: "default", codex: "default" },
  };
}

function hostSignIns() {
  return { grok: { state: "signed-out" }, pi: { state: "signed-in", source: "anthropic" } };
}

// What reached the backend and the desktop API is kept in localStorage so the
// browser assertion proves the exact input crossed each boundary.
function installMachinesFixture() {
  if (rebuildMode) {
    portalStore.store.setState({ selfId: "bk_self" as never });
    useEnvironmentStore.setState({ environments: [] });
  }
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => undefined,
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      const value = ((): unknown => {
        switch (command) {
          case "get_environment_extensions":
            return [];
          case "get_environment_inputs":
          case "get_container_lifecycle_snapshot":
          case "get_environment_resources":
            return null;
          case "list_recovery_copies":
            return { copies: [], limit: 3 };
          case "start_environment":
            throw new Error("Navigation must not start the stopped environment");
          case "get_node_status":
            return {
              nodeId: rebuildMode ? null : "bk_self",
              mode: "command",
              registrationEnabled: true,
              controllers: [],
              detachedControllers: [],
              suspendedSubordinateCount: 0,
            };
          case "list_nodes":
            return {
              revision: 1,
              mode: "command",
              suspended: false,
              nodes: fleetMode ? fleetNodes : [deskNode],
              pendingDetaches: [],
            };
          case "get_node_summaries":
            return {
              selfId: "bk_self",
              nodes: fleetMode
                ? fleetNodes.map((view) => ({
                    nodeId: view.nodeId,
                    view,
                    projects: [],
                    environments: [],
                    truncated: false,
                    freshness: "current",
                    loadedAt: 1,
                  }))
                : [],
            };
          case "get_portal_layout":
            return {
              revision: 1,
              machineOrder: fleetMachineOrder,
              projectOrder: [],
              projectFolders: {},
              repositoryOrder: [],
            };
          case "update_portal_layout":
            fleetMachineOrder = args?.machineOrder as string[];
            localStorage.setItem("machines-fixture-machine-order", fleetMachineOrder.join(","));
            return undefined;
          case "get_system_usage":
            return usageSample("bk_self");
          case "get_backend_profile":
            return { revision: 1, displayName: "Studio", colorToken: "violet", updatedAt: "t" };
          case "get_host_maintenance":
            return snapshot("2.26.0", "2.26.0");
          case "list_machine_agent_accounts":
            return {
              machines: [
                {
                  nodeId: "bk_self",
                  name: "Studio",
                  colorToken: "violet",
                  self: true,
                  state: "ok",
                  snapshot: hostAccounts(),
                  signIns: hostSignIns(),
                },
                ...(fleetMode
                  ? fleetNodes.map((node) => ({
                      nodeId: node.nodeId,
                      name: node.displayName,
                      colorToken: node.colorToken,
                      self: false,
                      state: "ok",
                      snapshot: hostAccounts(),
                      signIns: hostSignIns(),
                    }))
                  : []),
              ],
            };
          // The overview re-reads a machine once its event subscription is in place.
          case "list_agent_accounts":
            return hostAccounts();
          case "read_host_agent_sign_ins":
            return hostSignIns();
          case "invoke_on_node":
            return {
              outcome: "ok",
              result: routed(String(args?.command), String(args?.nodeId)),
            };
          case "add_node":
            localStorage.setItem("machines-fixture-add-node", JSON.stringify(args));
            return { ...deskNode, nodeId: "bk_new", displayName: "New" };
          default:
            return undefined;
        }
      })();
      return value as T;
    },
    connections: {
      list: async () =>
        fleetMode
          ? { ...connections, connections: connections.connections.slice(0, 1) }
          : connections,
      probe: async () => true,
      connect: async (input: ConnectToRemoteInput) => {
        localStorage.setItem("machines-fixture-connect", JSON.stringify(input));
        return connections;
      },
      rename: async () => connections,
      updateToken: async () => connections,
      use: async () => connections,
      forget: async () => connections,
      openWindow: async () => undefined,
    },
  };
  return true;
}

export function MachinesSettingsFixture() {
  useState(installMachinesFixture);
  const [showMachines, setShowMachines] = useState(true);
  useEffect(() => onGlobalSettingsCloseRequest(() => setShowMachines(false)), []);
  if (fleetMode) {
    return (
      <FederationProvider>
        <header
          data-testid="fleet-title-bar"
          className="flex h-[var(--desktop-title-bar-height)] items-center justify-end border-b border-border/80 bg-chrome pr-1.5"
        >
          <MachineCpuReadings />
          <SystemUsageIndicator />
        </header>
        <main className="p-4">
          <MachinesSettings />
        </main>
      </FederationProvider>
    );
  }
  if (new URLSearchParams(window.location.search).has("accountLayout")) {
    return (
      <FullscreenSettingsLayout
        open
        onOpenChange={() => {}}
        title="Settings"
        menuItems={[{ id: "machines", label: "Machines", icon: null }]}
        defaultSection="machines"
      >
        {() => <MachinesSettings />}
      </FullscreenSettingsLayout>
    );
  }
  return (
    <main className="p-4">
      <AppDialogHost />
      {showMachines && <MachinesSettings />}
      {rebuildMode && (
        <>
          <button onClick={() => useEnvironmentStore.getState().setEnvironments([oldEnvironment])}>
            Load environment snapshot
          </button>
          <button
            onClick={() =>
              useAppDialogStore.getState().open({
                kind: "environment-settings",
                environmentId: oldEnvironment.id,
                section: "container",
              })
            }
          >
            Request Rebuild again
          </button>
        </>
      )}
    </main>
  );
}
