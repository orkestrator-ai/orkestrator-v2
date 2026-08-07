import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_CREDENTIAL_FILE_ENV,
  runtimeEnvironmentForAgentQuery,
} from "./runtime-env.js";

describe("Claude Agent SDK runtime environment", () => {
  test("preserves the inherited environment when no managed file is configured", async () => {
    const environment = await runtimeEnvironmentForAgentQuery({
      PATH: "/usr/bin:/bin",
      GITHUB_TOKEN: "host-token",
      GH_TOKEN: "host-token",
    });

    expect(environment).toMatchObject({
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
});
