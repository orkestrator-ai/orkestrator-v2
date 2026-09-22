import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_CREDENTIAL_FILE_ENV,
  GITHUB_MCP_TOKEN_ENV,
  runtimeEnvironmentForAgentQuery,
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
    };

    try {
      await writeFile(credentialFile, "first-token");
      await expect(runtimeEnvironmentForAgentQuery(base)).resolves.toMatchObject({
        GITHUB_TOKEN: "first-token",
        GH_TOKEN: "first-token",
      });

      await writeFile(credentialFile, "second-token");
      await expect(runtimeEnvironmentForAgentQuery(base)).resolves.toMatchObject({
        GITHUB_TOKEN: "second-token",
        GH_TOKEN: "second-token",
      });

      await writeFile(credentialFile, "");
      const cleared = await runtimeEnvironmentForAgentQuery({
        ...base,
        GITHUB_TOKEN: "stale-token",
        GH_TOKEN: "stale-token",
      });
      expect(cleared.GITHUB_TOKEN).toBeUndefined();
      expect(cleared.GH_TOKEN).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when the configured credential file cannot be read", async () => {
    const environment = await runtimeEnvironmentForAgentQuery({
      [GITHUB_CREDENTIAL_FILE_ENV]: "/missing/managed-github-token",
      GITHUB_TOKEN: "stale-token",
      GH_TOKEN: "stale-token",
    });

    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.GH_TOKEN).toBeUndefined();
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
