import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setManagedGitHubCli } from "./github-cli-binary.js";
import {
  getContainerGitHubCredentialStatus,
  getHostGitHubToken,
  gitHubCliEnv,
  resolveGitHubToken,
  setGitHubCliConfigSource,
} from "./github-credentials.js";
import type { AppConfig } from "./models.js";

const config = (global: Partial<AppConfig["global"]>) => global as AppConfig["global"];
function useGlobal(global: Partial<AppConfig["global"]>): void {
  setGitHubCliConfigSource(async () => config(global));
}

describe("selected GitHub credentials", () => {
  let root: string;
  let previous: NodeJS.ProcessEnv;
  beforeEach(async () => {
    previous = { ...process.env };
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-github-credentials-"));
    const gh = path.join(root, "gh");
    await fs.writeFile(
      gh,
      `#!/bin/sh
# A stored login exists, but inherited tokens would take precedence.
test "$*" = 'auth token --hostname github.com' || exit 2
if test -n "$GH_TOKEN$GITHUB_TOKEN"; then echo inherited_identity; else echo host_identity; fi
`,
      { mode: 0o755 },
    );
    setManagedGitHubCli(gh);
    process.env.GH_TOKEN = "inherited_gh";
    process.env.GITHUB_TOKEN = "inherited_github";
  });
  afterEach(async () => {
    setGitHubCliConfigSource(undefined);
    setManagedGitHubCli(undefined);
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  test("host mode strips inherited tokens without mutating the base environment", async () => {
    useGlobal({ useHostGitHubCredentials: true, githubToken: "stored_pat" });
    const base = { PATH: "/managed/bin", GH_TOKEN: "other", GITHUB_TOKEN: "another" };
    expect(await gitHubCliEnv(base)).toEqual({ PATH: "/managed/bin" });
    expect(base.GH_TOKEN).toBe("other");
    expect(await gitHubCliEnv()).not.toHaveProperty("GH_TOKEN");
    expect(await gitHubCliEnv()).not.toHaveProperty("GITHUB_TOKEN");
    setGitHubCliConfigSource(undefined);
    expect(await gitHubCliEnv()).not.toHaveProperty("GH_TOKEN");
  });

  test("PAT mode overrides caller tokens and preserves other base variables", async () => {
    useGlobal({ useHostGitHubCredentials: false, githubToken: " stored_pat " });
    expect((await gitHubCliEnv()).GH_TOKEN).toBe("stored_pat");
    expect(
      await gitHubCliEnv({ PATH: "/managed/bin", GH_TOKEN: "other", GITHUB_TOKEN: "other" }),
    ).toEqual({ PATH: "/managed/bin", GH_TOKEN: "stored_pat" });
  });

  test.each([undefined, "", "  \n\t "])(
    "missing PAT %j fails closed despite a host login",
    async (githubToken) => {
      useGlobal({ useHostGitHubCredentials: false, githubToken });
      expect(await getHostGitHubToken()).toBe("host_identity");
      await expect(gitHubCliEnv()).rejects.toThrow("personal access token is missing");
      await expect(gitHubCliEnv({ GH_TOKEN: "host" })).rejects.toThrow("Settings");
      expect(
        await resolveGitHubToken(config({ useHostGitHubCredentials: false, githubToken })),
      ).toBeUndefined();
      expect(
        await getContainerGitHubCredentialStatus(
          config({ useHostGitHubCredentials: false, githubToken }),
        ),
      ).toEqual({ source: "pat", available: false });
    },
  );

  test("host token lookup, resolution and container status use the stored login", async () => {
    expect(await getHostGitHubToken()).toBe("host_identity");
    expect(await resolveGitHubToken(config({ githubToken: "unused_pat" }))).toBe("host_identity");
    expect(await getContainerGitHubCredentialStatus(config({}))).toEqual({
      source: "host-cli",
      available: true,
    });
    expect(process.env.GH_TOKEN).toBe("inherited_gh");
    expect(process.env.GITHUB_TOKEN).toBe("inherited_github");
  });

  test("PAT resolution and status do not require gh", async () => {
    setManagedGitHubCli(path.join(root, "missing"));
    const global = config({ useHostGitHubCredentials: false, githubToken: " stored_pat " });
    expect(await resolveGitHubToken(global)).toBe("stored_pat");
    expect(await getContainerGitHubCredentialStatus(global)).toEqual({
      source: "pat",
      available: true,
    });
    expect(await getHostGitHubToken()).toBeUndefined();
    expect(await getContainerGitHubCredentialStatus(config({}))).toEqual({
      source: "host-cli",
      available: false,
    });
  });

  test("empty host token is unavailable", async () => {
    await fs.writeFile(path.join(root, "gh"), "#!/bin/sh\nprintf '  \\n'\n", { mode: 0o755 });
    expect(await resolveGitHubToken(config({}))).toBeUndefined();
    expect(await getContainerGitHubCredentialStatus(config({}))).toEqual({
      source: "host-cli",
      available: false,
    });
  });
});
