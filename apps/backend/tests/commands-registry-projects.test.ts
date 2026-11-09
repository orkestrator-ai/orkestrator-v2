import { describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const {
  createCommandRegistry,
  createContext,
  createGitWorktreeWithOrigin,
  runGit,
  gitOutput,
  withGitArgumentStub,
} = await createCommandFixtures();

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

describe("use_https_git_remote", () => {
  const project = (localPath: string | null) => ({
    id: "https-project",
    name: "HTTPS project",
    gitUrl: "git@github.com:acme/widget.git",
    localPath,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });

  test("refuses a missing project and a project without a local checkout", async () => {
    const commands = createCommandRegistry();
    const { context } = createContext([], { project: project(null) });
    await expect(
      commands.get("use_https_git_remote")!({ projectId: "missing" }, context),
    ).rejects.toThrow("Project not found: missing");
    await expect(
      commands.get("use_https_git_remote")!({ projectId: "https-project" }, context),
    ).rejects.toThrow("no local checkout");
  });

  test("switches the requested checkout after HTTPS succeeds without changing project identity", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["remote", "set-url", "origin", "git@github.com:acme/widget.git"]);
    const storedProject = project(worktree);
    const { context } = createContext([], { project: storedProject });
    const commands = createCommandRegistry();
    await withGitArgumentStub(
      `
  *"--get-urlmatch credential.helper"*) printf 'test-helper\n'; exit 0 ;;
  *"ls-remote"*) printf 'abc\tHEAD\n'; exit 0 ;;
`,
      async () => {
        await expect(
          commands.get("use_https_git_remote")!({ projectId: storedProject.id }, context),
        ).resolves.toEqual({ remoteUrl: "https://github.com/acme/widget.git", changed: true });
      },
    );
    expect(await gitOutput(worktree, ["config", "--get", "remote.origin.url"])).toBe(
      "https://github.com/acme/widget.git",
    );
    expect((await context.storage.getProject(storedProject.id))?.gitUrl).toBe(
      "git@github.com:acme/widget.git",
    );
  });
});
