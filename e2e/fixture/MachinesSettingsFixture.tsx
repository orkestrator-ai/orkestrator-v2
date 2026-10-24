import { useState } from "react";
import type { ConnectionList, ConnectToRemoteInput } from "@orkestrator/protocol/connections";
import { MachinesSettings } from "../../apps/web/src/components/settings/machines/MachinesSettings";

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
    image: null,
  };
}

function routed(command: string): unknown {
  if (command === "get_host_maintenance") return snapshot("2.25.0", "2.26.0");
  if (command === "get_backend_profile") {
    return { revision: 2, displayName: deskNode.displayName, colorToken: "teal", updatedAt: "t" };
  }
  return { ok: true };
}

// What reached the backend and the desktop API is kept in localStorage so the
// browser assertion proves the exact input crossed each boundary.
function installMachinesFixture() {
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => undefined,
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      const value = ((): unknown => {
        switch (command) {
          case "get_node_status":
            return {
              nodeId: "bk_self",
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
              nodes: [deskNode],
              pendingDetaches: [],
            };
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
                  snapshot: {
                    accounts: ["claude", "codex"].map((platform) => ({
                      id: "default",
                      platform,
                      label: "Host login",
                      isDefault: true,
                      isActive: true,
                      signedIn: true,
                      identity: {},
                    })),
                    active: { claude: "default", codex: "default" },
                  },
                },
              ],
            };
          case "invoke_on_node":
            return { outcome: "ok", result: routed(String(args?.command)) };
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
      list: async () => connections,
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
  return (
    <main className="p-4">
      <MachinesSettings />
    </main>
  );
}
