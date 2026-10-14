import { describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry, createContext } = await createCommandFixtures();

describe("Electron backend command registry", () => {
  // The `security` stub only takes effect on darwin, where `getHostClaudeCredentials`
  // consults the Keychain; elsewhere resolution starts at the on-disk credential.
  // Seeding both with the same payload keeps these tests asserting the same thing
  // on every platform instead of silently depending on the developer's OS.

  test("loads, validates, and saves desktop connection records", async () => {
    const commands = createCommandRegistry();
    const { context } = createContext([]);
    await expect(commands.get("get_desktop_connections")?.({}, context)).resolves.toEqual({
      activeConnectionId: "local",
      connections: [],
    });
    const remote = {
      activeConnectionId: "remote-1",
      connections: [
        {
          id: "remote-1",
          name: "desk.example",
          address: "https://desk.example",
          encryptedToken: "encrypted",
          lastConnectedAt: "2026-07-14T00:00:00.000Z",
        },
      ],
    };
    await commands.get("save_desktop_connections")?.({ desktopConnections: remote }, context);
    await expect(commands.get("get_desktop_connections")?.({}, context)).resolves.toEqual(remote);
    expect(() =>
      commands.get("save_desktop_connections")?.(
        { desktopConnections: { activeConnectionId: "local" } },
        context,
      ),
    ).toThrow("connections");
  });
});
