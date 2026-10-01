import { useState } from "react";
import type { ConnectionList, ConnectToRemoteInput } from "@orkestrator/protocol/connections";
import { ConnectionsSettings } from "../../apps/web/src/components/settings/ConnectionsSettings";

const initialList: ConnectionList = {
  activeConnectionId: "remote-1",
  credentialStorage: "secure",
  connections: [
    {
      id: "remote-1",
      name: "desk.example",
      address: "https://desk.example",
      kind: "remote",
      active: true,
      requiresToken: false,
    },
  ],
};

// Persist the adapter's received value across the Add flow's reload so the
// browser assertion proves that all input reached the connection API.
function installConnectionsFixture() {
  window.orkestrator = {
    ...window.orkestrator!,
    connections: {
      list: async () =>
        JSON.parse(
          localStorage.getItem("nickname-fixture-list") ?? JSON.stringify(initialList),
        ) as ConnectionList,
      probe: async () => true,
      connect: async (input: ConnectToRemoteInput) => {
        localStorage.setItem("nickname-fixture-connect", JSON.stringify(input));
        return initialList;
      },
      rename: async (_connectionId: string, nickname: string | null) => {
        const list: ConnectionList = {
          ...initialList,
          connections: initialList.connections.map((connection) => ({
            ...connection,
            name: nickname ?? "desk.example",
            ...(nickname ? { nickname } : {}),
          })),
        };
        localStorage.setItem("nickname-fixture-rename", JSON.stringify(nickname));
        localStorage.setItem("nickname-fixture-list", JSON.stringify(list));
        return list;
      },
      updateToken: async () => initialList,
      use: async () => initialList,
      forget: async () => initialList,
    },
  };
  return true;
}

export function ConnectionsSettingsFixture() {
  useState(installConnectionsFixture);
  return (
    <main className="p-4">
      <ConnectionsSettings />
    </main>
  );
}
