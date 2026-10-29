import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_CREDENTIAL_FILE_ENV,
  GITHUB_MCP_TOKEN_ENV,
  readGitHubCliToken,
  runtimeEnvironmentForAgentQuery,
  runtimeEnvironmentForSessionQuery,
} from "./runtime-env.js";

const noGhToken = async () => undefined;

describe("Claude Agent SDK runtime environment", () => {
  test("preserves the inherited environment when no managed file is configured", async () => {
    const environment = await runtimeEnvironmentForAgentQuery({
      PATH: "/usr/bin:/bin",
      GITHUB_TOKEN: "host-token",
      GH_TOKEN: "host-token",
    });

    expect(environment).toMatchObject({
      [GITHUB_MCP_TOKEN_ENV]: "host-token",
      PATH: "/usr/bin:/bin",
      GITHUB_TOKEN: "host-token",
      GH_TOKEN: "host-token",
    });
  });

  test("reads rotations and clearing for every query", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-runtime-env-"));
    const credentialFile = join(directory, "github-token");
    const base = {
      PATH: "/usr/bin:/bin",
      [GITHUB_CREDENTIAL_FILE_ENV]: credentialFile,
      [GITHUB_MCP_TOKEN_ENV]: "stale-mcp-token",
    };

    try {
      await writeFile(credentialFile, "first-token");
      await expect(runtimeEnvironmentForAgentQuery(base)).resolves.toMatchObject({
        GITHUB_TOKEN: "first-token",
        GH_TOKEN: "first-token",
        [GITHUB_MCP_TOKEN_ENV]: "first-token",
      });

      await writeFile(credentialFile, "second-token");
      await expect(runtimeEnvironmentForAgentQuery(base)).resolves.toMatchObject({
        GITHUB_TOKEN: "second-token",
        GH_TOKEN: "second-token",
        [GITHUB_MCP_TOKEN_ENV]: "second-token",
      });

      await writeFile(credentialFile, "");
      const cleared = await runtimeEnvironmentForAgentQuery({
        ...base,
        GITHUB_TOKEN: "stale-token",
        GH_TOKEN: "stale-token",
      });
      expect(cleared.GITHUB_TOKEN).toBeUndefined();
      expect(cleared.GH_TOKEN).toBeUndefined();
      expect(cleared[GITHUB_MCP_TOKEN_ENV]).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when the configured credential file cannot be read", async () => {
    const environment = await runtimeEnvironmentForAgentQuery({
      [GITHUB_CREDENTIAL_FILE_ENV]: "/missing/managed-github-token",
      GITHUB_TOKEN: "stale-token",
      GH_TOKEN: "stale-token",
      [GITHUB_MCP_TOKEN_ENV]: "stale-mcp-token",
    });

    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment[GITHUB_MCP_TOKEN_ENV]).toBeUndefined();
  });

  test("falls back to the gh CLI token for the GitHub MCP header on local bridges", async () => {
    const ghEnvironments: NodeJS.ProcessEnv[] = [];
    const environment = await runtimeEnvironmentForAgentQuery(
      { PATH: "/opt/homebrew/bin:/usr/bin" },
      undefined,
      async (env) => {
        ghEnvironments.push(env);
        return "gh-cli-token";
      },
    );

    expect(environment[GITHUB_MCP_TOKEN_ENV]).toBe("gh-cli-token");
    expect(ghEnvironments[0]?.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    // Only the MCP header variable is filled; gh keeps using its own keyring.
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.GH_TOKEN).toBeUndefined();
  });

  test("keeps an explicit GitHub MCP token without consulting gh", async () => {
    let ghCalls = 0;
    const environment = await runtimeEnvironmentForAgentQuery(
      { [GITHUB_MCP_TOKEN_ENV]: "explicit-pat", GITHUB_TOKEN: "host-token" },
      undefined,
      async () => {
        ghCalls += 1;
        return "gh-cli-token";
      },
    );

    expect(environment[GITHUB_MCP_TOKEN_ENV]).toBe("explicit-pat");
    expect(ghCalls).toBe(0);
  });

  test("prefers GH_TOKEN over GITHUB_TOKEN for local MCP authentication", async () => {
    const environment = await runtimeEnvironmentForAgentQuery(
      { GITHUB_TOKEN: "other-identity", GH_TOKEN: "gh-identity" },
      undefined,
      async () => {
        throw new Error("gh must not be called when an env token exists");
      },
    );
    expect(environment[GITHUB_MCP_TOKEN_ENV]).toBe("gh-identity");
  });

  test("uses GH_TOKEN by itself and replaces a whitespace-only MCP token", async () => {
    const environment = await runtimeEnvironmentForAgentQuery(
      { GH_TOKEN: "gh-identity", [GITHUB_MCP_TOKEN_ENV]: "  " },
      undefined,
      async () => {
        throw new Error("gh must not be called when GH_TOKEN exists");
      },
    );
    expect(environment[GITHUB_MCP_TOKEN_ENV]).toBe("gh-identity");
  });

  test("caches a local gh lookup across queries", async () => {
    let calls = 0;
    const reader = async () => {
      calls += 1;
      return "cached-identity";
    };
    const env = { PATH: "/test/gh" };
    expect(
      (await runtimeEnvironmentForAgentQuery(env, undefined, reader))[GITHUB_MCP_TOKEN_ENV],
    ).toBe("cached-identity");
    expect(
      (await runtimeEnvironmentForAgentQuery(env, undefined, reader))[GITHUB_MCP_TOKEN_ENV],
    ).toBe("cached-identity");
    expect(calls).toBe(1);
  });

  test("calls the real gh reader with the expected argv and trims its output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-fake-gh-"));
    const gh = join(directory, "gh");
    const args = join(directory, "args");
    try {
      await writeFile(
        gh,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_TEST_ARGS"\nprintf "  fake-token\\n"\n',
      );
      await chmod(gh, 0o755);
      expect(await readGitHubCliToken({ PATH: directory, GH_TEST_ARGS: args })).toBe("fake-token");
      expect(await readFile(args, "utf8")).toBe("auth\ntoken\n--hostname\ngithub.com\n");
      await writeFile(gh, "#!/bin/sh\nexit 1\n");
      expect(await readGitHubCliToken({ PATH: directory })).toBeUndefined();
      expect(await readGitHubCliToken({ PATH: join(directory, "missing") })).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("bounds a stalled gh lookup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-slow-gh-"));
    const gh = join(directory, "gh");
    try {
      await writeFile(gh, "#!/bin/sh\nexec /bin/sleep 4\n");
      await chmod(gh, 0o755);
      const started = Date.now();
      expect(await readGitHubCliToken({ PATH: directory })).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(3_500);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 5_000);

  test("leaves the GitHub MCP token unset when gh has no login", async () => {
    const environment = await runtimeEnvironmentForAgentQuery(
      { PATH: "/usr/bin" },
      undefined,
      noGhToken,
    );

    expect(environment[GITHUB_MCP_TOKEN_ENV]).toBeUndefined();
  });

  test("uses the managed container token for the GitHub MCP header", async () => {
    let ghCalls = 0;
    const readGhToken = async () => {
      ghCalls += 1;
      return "gh-cli-token";
    };
    const base = {
      [GITHUB_CREDENTIAL_FILE_ENV]: "/tmp/orkestrator-ai/github-token",
    };

    const managed = await runtimeEnvironmentForAgentQuery(
      base,
      async () => "managed-token\n",
      readGhToken,
    );
    expect(managed[GITHUB_MCP_TOKEN_ENV]).toBe("managed-token");

    const cleared = await runtimeEnvironmentForAgentQuery(base, async () => "", readGhToken);
    expect(cleared[GITHUB_MCP_TOKEN_ENV]).toBeUndefined();
    expect(ghCalls).toBe(0);
  });
});

describe("graph agent sessions (item 209)", () => {
  const graphPolicy = {
    capabilityPolicy: { deny: ["file.write" as const], extendedDeny: ["git.push", "github.write"] },
  };

  test("a session whose policy denies github.write gets no GitHub credential", async () => {
    let fileReads = 0;
    let ghReads = 0;
    const environment = await runtimeEnvironmentForSessionQuery(
      graphPolicy,
      {
        PATH: "/usr/bin:/bin",
        GH_TOKEN: "host-token",
        GITHUB_TOKEN: "host-token",
        [GITHUB_MCP_TOKEN_ENV]: "mcp-token",
        [GITHUB_CREDENTIAL_FILE_ENV]: "/tmp/orkestrator-ai/github-token",
      },
      {
        readTextFile: async () => {
          fileReads += 1;
          return "file-token";
        },
        readGhToken: async () => {
          ghReads += 1;
          return "gh-token";
        },
        ghConfigDir: async () => "/tmp/empty-gh",
      },
    );
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment[GITHUB_MCP_TOKEN_ENV]).toBeUndefined();
    expect(environment[GITHUB_CREDENTIAL_FILE_ENV]).toBeUndefined();
    expect(environment.GH_CONFIG_DIR).toBe("/tmp/empty-gh");
    expect(environment.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(environment.GIT_CONFIG_VALUE_0).toBe("");
    expect(environment.PATH).toBe("/usr/bin:/bin");
    expect(Object.values(environment).join("\n")).not.toContain("token");
    // Neither the managed file nor `gh auth token` was read.
    expect(fileReads).toBe(0);
    expect(ghReads).toBe(0);
  });

  test("an empty gh configuration directory is created when none is given", async () => {
    const environment = await runtimeEnvironmentForSessionQuery(graphPolicy, { PATH: "/bin" });
    expect(environment.GH_CONFIG_DIR).toContain("orkestrator-gh-withheld-");
  });

  test("any other session keeps the ordinary runtime environment", async () => {
    const environment = await runtimeEnvironmentForSessionQuery(
      { capabilityPolicy: { deny: ["network"] } },
      { PATH: "/usr/bin:/bin", GH_TOKEN: "host-token" },
      { readGhToken: noGhToken },
    );
    expect(environment).toMatchObject({
      GH_TOKEN: "host-token",
      [GITHUB_MCP_TOKEN_ENV]: "host-token",
    });
  });
});
