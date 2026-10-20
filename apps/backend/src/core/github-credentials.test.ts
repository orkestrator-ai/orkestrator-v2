import { afterEach, describe, expect, test } from "bun:test";

import { gitHubCliEnv, setGitHubCliConfigSource } from "./github-credentials.js";
import type { AppConfig } from "./models.js";

function useGlobal(global: Partial<AppConfig["global"]>): void {
  setGitHubCliConfigSource(async () => global as AppConfig["global"]);
}

describe("gitHubCliEnv", () => {
  afterEach(() => setGitHubCliConfigSource(undefined));

  test("leaves gh on its own login when host credentials are selected", async () => {
    useGlobal({ useHostGitHubCredentials: true, githubToken: "stored_pat" });
    expect(await gitHubCliEnv()).toBeUndefined();
    const base = { PATH: "/managed/bin" };
    expect(await gitHubCliEnv(base)).toBe(base);
  });

  test("hands gh the stored PAT when it is the selected credential", async () => {
    useGlobal({ useHostGitHubCredentials: false, githubToken: " stored_pat " });
    expect((await gitHubCliEnv())?.GH_TOKEN).toBe("stored_pat");
    expect(await gitHubCliEnv({ PATH: "/managed/bin" })).toEqual({
      PATH: "/managed/bin",
      GH_TOKEN: "stored_pat",
    });
  });

  test("falls back to the inherited environment without a PAT or config source", async () => {
    useGlobal({ useHostGitHubCredentials: false });
    expect(await gitHubCliEnv()).toBeUndefined();
    setGitHubCliConfigSource(undefined);
    expect(await gitHubCliEnv()).toBeUndefined();
  });
});
