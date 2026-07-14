import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseConnectionList,
  parseStoredDesktopConnections,
} from "../../../packages/protocol/src/connections";

describe("connection protocol validation", () => {
  test("parses and clones stored desktop connections", () => {
    const input = {
      activeConnectionId: "remote-1",
      connections: [{
        id: "remote-1",
        name: "desk.example",
        address: "https://desk.example",
        encryptedToken: "encrypted",
        lastConnectedAt: "2026-07-14T00:00:00.000Z",
      }],
    };
    const parsed = parseStoredDesktopConnections(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.connections[0]).not.toBe(input.connections[0]);
  });

  test("publishes the connection contract from the protocol package", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../../packages/protocol/package.json", import.meta.url), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(packageJson.exports?.["./connections"]).toBe("./src/connections.ts");
  });

  test("rejects malformed stored records and malformed renderer summaries", () => {
    expect(() => parseStoredDesktopConnections(null)).toThrow("desktop connections");
    expect(() => parseStoredDesktopConnections({ activeConnectionId: "local" })).toThrow("connections");
    expect(() => parseStoredDesktopConnections({ activeConnectionId: "local", connections: [{}] })).toThrow("connections[0].id");
    expect(() => parseConnectionList({ activeConnectionId: "local", connections: [{
      id: "local",
      name: "Local",
      address: null,
      kind: "unknown",
      active: true,
      requiresToken: false,
    }] })).toThrow("kind");
    expect(() => parseConnectionList({ activeConnectionId: "local", connections: [], credentialStorage: "disk" })).toThrow("credentialStorage");
  });

  test("accepts local and remote connection summaries", () => {
    expect(parseConnectionList({
      activeConnectionId: "remote-1",
      credentialStorage: "secure",
      connections: [
        { id: "local", name: "Local", address: null, kind: "local", active: false, requiresToken: false },
        { id: "remote-1", name: "Desk", address: "https://desk.example", kind: "remote", active: true, requiresToken: false },
      ],
    })).toMatchObject({ activeConnectionId: "remote-1", credentialStorage: "secure" });
  });
});
