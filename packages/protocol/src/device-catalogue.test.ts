import { describe, expect, test } from "bun:test";
import {
  legacyDesktopConnections,
  migrateDesktopConnections,
  migratedRouteId,
  orderedRoutes,
  parseDeviceCatalogue,
  validateIdentityFile,
  validatePort,
  validateSshDestination,
  type DeviceCatalogue,
} from "./device-catalogue.js";
import type { StoredDesktopConnections } from "./connections.js";

const legacy: StoredDesktopConnections = {
  activeConnectionId: "c2",
  connections: [
    {
      id: "c1",
      name: "mini.tailnet.ts.net",
      nickname: "Mac mini",
      address: "https://mini.tailnet.ts.net",
      encryptedToken: "ZW5j",
      lastConnectedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "c2",
      name: "vps.tailnet.ts.net",
      address: "https://vps.tailnet.ts.net",
      encryptedToken: "",
      lastConnectedAt: "2026-10-02T00:00:00.000Z",
    },
  ],
};

describe("SSH route validation", () => {
  test("SH-12: rejects option-like, control-character and shell input before spawn", () => {
    for (const bad of [
      "-oProxyCommand=touch /tmp/x",
      "host;rm -rf /",
      "host name",
      "host\nother",
      "$(whoami)@host",
      "`id`",
      "a@b@c",
      "ssh://host",
      "user@-host",
      "",
    ]) {
      expect(() => validateSshDestination(bad)).toThrow();
    }
  });

  test("SH-01: accepts aliases and user@host without forcing a user or port", () => {
    expect(validateSshDestination("build-machine")).toBe("build-machine");
    expect(validateSshDestination(" deploy@10.0.0.4 ")).toBe("deploy@10.0.0.4");
    expect(validateSshDestination("[fe80::1%en0]")).toBe("[fe80::1%en0]");
  });

  test("ports and identity paths are bounded", () => {
    expect(validatePort("2222", "SSH port")).toBe(2222);
    expect(() => validatePort(0, "SSH port")).toThrow();
    expect(() => validatePort(70_000, "SSH port")).toThrow();
    expect(validateIdentityFile("~/.ssh/id_ed25519")).toBe("~/.ssh/id_ed25519");
    expect(validateIdentityFile("")).toBeUndefined();
    expect(() => validateIdentityFile("relative/key")).toThrow();
    expect(() => validateIdentityFile("-----BEGIN OPENSSH PRIVATE KEY-----")).toThrow();
  });
});

describe("catalogue migration", () => {
  test("MG-01: each address becomes a provisional entry that keeps its ID, alias and encrypted token", () => {
    const catalogue = migrateDesktopConnections(legacy, "2026-10-21T00:00:00.000Z");
    expect(catalogue.version).toBe(2);
    expect(catalogue.migratedFromVersion).toBe(1);
    expect(catalogue.activeConnectionId).toBe("c2");
    expect(catalogue.backends.map((backend) => backend.id)).toEqual(["c1", "c2"]);
    const [mini] = catalogue.backends;
    expect(mini!.localAlias).toBe("Mac mini");
    expect(mini!.verifiedInstallationId).toBeUndefined();
    expect(mini!.routes).toEqual([
      {
        id: migratedRouteId("c1"),
        kind: "https",
        origin: "https://mini.tailnet.ts.net",
        encryptedToken: "ZW5j",
        enabled: true,
        lastConnectedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    expect(parseDeviceCatalogue(JSON.parse(JSON.stringify(catalogue)))).toEqual(catalogue);
  });

  test("migration never merges two addresses even if they later prove one identity", () => {
    const duplicated = migrateDesktopConnections({
      activeConnectionId: "local",
      connections: [legacy.connections[0]!, { ...legacy.connections[0]!, id: "c9" }],
    });
    expect(duplicated.backends).toHaveLength(2);
  });

  test("a malformed row is dropped without blocking the others", () => {
    const catalogue = migrateDesktopConnections({
      activeConnectionId: "local",
      connections: [{ ...legacy.connections[0]!, address: "not a url" }, legacy.connections[1]!],
    });
    expect(catalogue.backends.map((backend) => backend.id)).toEqual(["c2"]);
  });

  test("the legacy view omits SSH-only machines instead of down-converting them", () => {
    const catalogue: DeviceCatalogue = {
      ...migrateDesktopConnections(legacy),
      backends: [
        ...migrateDesktopConnections(legacy).backends,
        {
          id: "ssh-only",
          fallbackName: "build-machine",
          routeOrder: ["ssh-1" as never],
          routes: [
            {
              id: "ssh-1" as never,
              kind: "ssh",
              destination: "build-machine",
              remoteGatewayPort: 34121,
              encryptedToken: "",
              enabled: true,
            },
          ],
          autoConnect: true,
        },
      ],
    };
    const legacyView = legacyDesktopConnections(catalogue);
    expect(legacyView.connections.map((connection) => connection.id)).toEqual(["c1", "c2"]);
    expect(legacyView.connections[0]!.nickname).toBe("Mac mini");
  });
});

describe("catalogue parsing", () => {
  test("repairs route order and rejects duplicates and unknown versions", () => {
    const catalogue = migrateDesktopConnections(legacy);
    const entry = catalogue.backends[0]!;
    const parsed = parseDeviceCatalogue({
      ...catalogue,
      backends: [{ ...entry, routeOrder: ["missing", entry.routes[0]!.id, entry.routes[0]!.id] }],
    });
    expect(orderedRoutes(parsed.backends[0]!).map((route) => route.id)).toEqual([
      entry.routes[0]!.id,
    ]);
    expect(() => parseDeviceCatalogue({ ...catalogue, version: 3 })).toThrow();
    expect(() => parseDeviceCatalogue({ ...catalogue, backends: [entry, { ...entry }] })).toThrow();
    expect(() =>
      parseDeviceCatalogue({
        ...catalogue,
        backends: [{ ...entry, routes: [{ ...entry.routes[0]!, origin: "https://u:p@host" }] }],
      }),
    ).toThrow();
  });

  test("an unknown active connection falls back to Local", () => {
    const catalogue = migrateDesktopConnections(legacy);
    expect(
      parseDeviceCatalogue({ ...catalogue, activeConnectionId: "gone" }).activeConnectionId,
    ).toBe("local");
  });

  test("feature flags default on and accept explicit disables", () => {
    const catalogue = migrateDesktopConnections(legacy);
    const { features: _features, ...withoutFeatures } = catalogue;
    expect(parseDeviceCatalogue(withoutFeatures).features.sshRoutes).toBe(true);
    expect(parseDeviceCatalogue({ ...catalogue, features: { sshRoutes: false } }).features).toEqual(
      { federation: true, sshRoutes: false, routeFallback: true },
    );
  });
});
