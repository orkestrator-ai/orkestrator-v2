/**
 * Part of the host side of a project's Git mirror, with real Git against real local
 * repositories: building, refreshing, credentials and access kinds. The suite is split across
 * `project-git-mirror-*.integration.test.ts` so `bun test --parallel` can run the parts
 * on separate workers; the shared fixture and helpers live in
 * `project-git-mirror-fixtures.ts`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GIT_MIRROR_REFRESH_INTERVAL_MS } from "../src/core/project-git-mirror";
import type { GitMirrorAccess } from "../src/core/project-git-mirror-access";
import { runCommand } from "../src/core/shell";
import { startGitHttpRemote } from "./git-http-fixture";
import {
  registerGitMirrorFixture,
  PROJECT_ID,
  commit,
  dataDir,
  git,
  mirrorPath,
  mirrorRefs,
  mountPath,
  nonObjectFiles,
  project,
  projectDir,
  readState,
  refresh,
  remote,
  root,
  savedEnv,
  storage,
  work,
} from "./project-git-mirror-fixtures";

// Real git processes: keep Bun's 5 s default from killing them under aggregate load.
setDefaultTimeout(15_000);

registerGitMirrorFixture();

describe("building and refreshing", () => {
  test("builds a bare mirror of the branches, readable by any user in a container", async () => {
    git(work, ["tag", "v1"]);
    git(work, ["push", "-q", "origin", "v1"]);
    git(work, ["push", "-q", "origin", "HEAD:refs/pull/1/head"]);

    expect(await refresh()).toBe("built");

    expect(mirrorRefs()).toEqual(["refs/heads/main"]);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "rev-parse", "--is-bare-repository"])).toBe(
      "true",
    );
    expect(await nonObjectFiles(mirrorPath())).not.toContainEqual(expect.stringContaining("hooks"));
    // Everything a clone reads is world-readable, directories traversable.
    const walk = async (directory: string): Promise<void> => {
      const mode = (await fs.stat(directory)).mode;
      expect(mode & 0o005).toBe(0o005);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else expect((await fs.stat(target)).mode & 0o004).toBe(0o004);
      }
    };
    await walk(mountPath());
    // Only the bind source is open; no other host user can traverse to it.
    expect((await fs.stat(path.join(dataDir, "git-mirrors"))).mode & 0o077).toBe(0);
    expect((await fs.stat(projectDir())).mode & 0o077).toBe(0);
  });

  test("a refresh fetches new work and prunes deleted branches in place", async () => {
    git(work, ["push", "-q", "origin", "HEAD:refs/heads/feature"]);
    expect(await refresh()).toBe("built");
    expect(mirrorRefs()).toContain("refs/heads/feature");
    const { ino } = await fs.stat(mirrorPath());

    commit("two.txt", "two\n");
    git(work, ["push", "-q", "origin", "--delete", "feature"]);
    expect(await refresh()).toBe("fetched");

    expect((await fs.stat(mirrorPath())).ino).toBe(ino);
    expect(mirrorRefs()).toEqual(["refs/heads/main"]);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "log", "-1", "--format=%s", "main"])).toBe(
      "change two.txt",
    );
  });

  test("launches inside the refresh interval do not contact the remote", async () => {
    let fetches = 0;
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) fetches += 1;
      return runCommand(command, args, options);
    };
    let clock = 1_000_000;
    const options = { force: false, run, now: () => clock };

    expect(await refresh(options)).toBe("built");
    expect(fetches).toBe(1);
    clock += GIT_MIRROR_REFRESH_INTERVAL_MS - 1;
    expect(await refresh(options)).toBe("skipped-recent");
    expect(fetches).toBe(1);
    clock += 1;
    expect(await refresh(options)).toBe("fetched");
    expect(fetches).toBe(2);
  });

  test("a changed project URL rebuilds instead of mixing two remotes", async () => {
    expect(await refresh()).toBe("built");
    const other = path.join(root, "other.git");
    git(root, ["clone", "-q", "--bare", remote, other]);

    expect(await refresh({}, { id: PROJECT_ID, gitUrl: `file://${other}` })).toBe("built");
  });

  test("an empty remote publishes nothing", async () => {
    const empty = path.join(root, "empty.git");
    git(root, ["init", "-q", "--bare", "--initial-branch=main", empty]);

    expect(await refresh({}, { id: PROJECT_ID, gitUrl: `file://${empty}` })).toBe("empty");
    expect(existsSync(mirrorPath())).toBe(false);
  });
});

describe("credentials", () => {
  const secret = "s3cret-token-value";
  const backendSecret = "backend-token-value";

  type Call = { args: string[]; env: NodeJS.ProcessEnv };

  /**
   * Sends the transfer to the local remote; everything else is what Git would
   * have been given, recorded in `calls`.
   */
  function redirecting(url: string, calls: Call[]) {
    const run: typeof runCommand = (command, args = [], options = {}) => {
      if (!args.includes("fetch")) return runCommand(command, args, options);
      calls.push({ args: [...args], env: { ...options.env } });
      const real = args.map((arg) => (arg === url ? `file://${remote}` : arg));
      return runCommand(command, real, {
        ...options,
        env: { ...options.env, GIT_ALLOW_PROTOCOL: "file" },
      });
    };
    return run;
  }

  /** The backend's own GitHub credential, which a mirror fetch must never use. */
  function selectBackendPat() {
    const load = storage.loadConfig.bind(storage);
    storage.loadConfig = async () => {
      const config = await load();
      return {
        ...config,
        global: { ...config.global, useHostGitHubCredentials: false, githubToken: backendSecret },
      };
    };
    process.env.GH_TOKEN = backendSecret;
    process.env.GITHUB_TOKEN = backendSecret;
  }

  afterEach(() => {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "HOME"] as const) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  async function expectNoSecretInMirror(kind?: string) {
    const config = await fs.readFile(path.join(mirrorPath(kind), "config"), "utf8");
    for (const forbidden of ["url", "remote", "credential", "extraheader", "insteadOf"]) {
      expect(config.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(existsSync(path.join(mirrorPath(kind), "FETCH_HEAD"))).toBe(false);
    for (const file of await nonObjectFiles(path.join(projectDir()))) {
      const content = await fs.readFile(file, "utf8");
      expect(content).not.toContain(secret);
      expect(content).not.toContain(backendSecret);
    }
  }

  test("a token in the project URL reaches neither the mirror nor its state", async () => {
    const url = `https://user:${secret}@github.invalid/acme/repo.git`;
    const calls: Call[] = [];

    expect(
      await refresh(
        { run: redirecting(url, calls) },
        { id: PROJECT_ID, gitUrl: url },
        {
          kind: "anonymous",
        },
      ),
    ).toBe("built");

    expect(calls).toHaveLength(1);
    await expectNoSecretInMirror("anonymous");
  });

  test("the containers' token goes per transfer, by helper and environment, never by argument", async () => {
    selectBackendPat();
    const url = "https://github.com/acme/repo.git";
    const calls: Call[] = [];

    expect(
      await refresh(
        { run: redirecting(url, calls) },
        { id: PROJECT_ID, gitUrl: url },
        {
          kind: "github-pat",
          token: secret,
        },
      ),
    ).toBe("built");

    expect(calls).toHaveLength(1);
    const [{ args, env }] = calls as [Call];
    expect(env.ORKESTRATOR_GITHUB_TOKEN).toBe(secret);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(args.join(" ")).not.toContain(secret);
    expect(args.join(" ")).toContain("credential.https://github.com.helper=");
    await expectNoSecretInMirror("github-pat");
  });

  test("with no token for containers, a GitHub remote is fetched with no credential at all", async () => {
    // The backend has a PAT selected and in its environment, as it often does.
    selectBackendPat();
    const url = "git@github.com:acme/repo.git";
    const https = "https://github.com/acme/repo.git";
    const calls: Call[] = [];

    expect(
      await refresh(
        { run: redirecting(https, calls) },
        { id: PROJECT_ID, gitUrl: url },
        {
          kind: "anonymous",
        },
      ),
    ).toBe("built");

    const [{ args, env }] = calls as [Call];
    // Converted as the container's setup script converts it, and HTTPS only.
    expect(args).toContain(https);
    expect(args).not.toContain(url);
    expect(env.GIT_ALLOW_PROTOCOL).toBe("https");
    // Neither the backend's token nor its Git configuration or helpers.
    expect(Object.values(env).join("\n")).not.toContain(backendSecret);
    expect(env.ORKESTRATOR_GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe(os.devNull);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(args.join(" ")).not.toContain("credential.https://github.com.helper=");
    expect(args).toContain("credential.helper=");
    await expectNoSecretInMirror("anonymous");
  });

  test("a private remote is never fetched with the host's own credentials", async () => {
    const credentials = { username: "host-user", password: "host-password" };
    const server = startGitHttpRemote(root, { credentials });
    try {
      const url = `${server.origin}/remote.git`;
      // Everything the host offers: a helper in global config, a `.netrc` in
      // its home and an askpass program. Each one alone lets plain Git in.
      const helper = path.join(root, "helper.sh");
      await fs.writeFile(
        helper,
        `#!/bin/sh\ntest "$1" = get && printf 'username=%s\\npassword=%s\\n' ${credentials.username} ${credentials.password}\n`,
        { mode: 0o755 },
      );
      await fs.appendFile(process.env.GIT_CONFIG_GLOBAL!, `[credential]\n\thelper = ${helper}\n`);
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await fs.writeFile(
        path.join(home, ".netrc"),
        `machine 127.0.0.1 login ${credentials.username} password ${credentials.password}\n`,
        { mode: 0o600 },
      );
      process.env.HOME = home;
      const askpass = path.join(root, "askpass.sh");
      await fs.writeFile(askpass, `#!/bin/sh\necho ${credentials.password}\n`, { mode: 0o755 });
      process.env.GIT_ASKPASS = askpass;
      // Async: the server answers on this process's event loop.
      await runCommand("git", ["ls-remote", url], { timeoutMs: 30_000 });
      const before = server.refused();

      expect(await refresh({}, { id: PROJECT_ID, gitUrl: url }, { kind: "anonymous" })).toBe(
        "failed",
      );

      expect(server.refused()).toBeGreaterThan(before);
      expect(existsSync(mirrorPath("anonymous"))).toBe(false);
      expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test("a refused remote with a checkout is probed before seeding and backed off", async () => {
    const server = startGitHttpRemote(root, {
      credentials: { username: "user", password: "password" },
    });
    try {
      let copies = 0;
      let probes = 0;
      const run: typeof runCommand = (command, args, options) => {
        if (args?.includes("ls-remote")) probes++;
        if (args?.includes("+refs/remotes/*:refs/seed/*")) copies++;
        return runCommand(command, args, options);
      };
      const target = { ...project(), gitUrl: server.origin + "/remote.git", localPath: work };
      const options = { run, force: false, now: () => 1_000_000 };
      expect(await refresh(options, target, { kind: "anonymous" })).toBe("failed");
      expect(await refresh(options, target, { kind: "anonymous" })).toBe("skipped-recent");
      expect(probes).toBe(1);
      expect(copies).toBe(0);
    } finally {
      await server.stop();
    }
  });

  test("a public remote over HTTP builds with no credential", async () => {
    const server = startGitHttpRemote(root);
    try {
      expect(
        await refresh(
          {},
          { id: PROJECT_ID, gitUrl: `${server.origin}/remote.git` },
          {
            kind: "anonymous",
          },
        ),
      ).toBe("built");
      expect(git(root, [`--git-dir=${mirrorPath("anonymous")}`, "rev-parse", "main"])).toBe(
        git(remote, ["rev-parse", "main"]),
      );
    } finally {
      await server.stop();
    }
  });

  test("a URL a container's clone cannot use gets no mirror", async () => {
    // A local path, without the agent-test fixture's own bind, and `file://`.
    for (const gitUrl of [remote, `file://${remote}`]) {
      expect(await refresh({}, { id: PROJECT_ID, gitUrl }, { kind: "anonymous" })).toBe("failed");
      expect(existsSync(mirrorPath("anonymous"))).toBe(false);
    }
  });
});

describe("access kinds", () => {
  const PAT: GitMirrorAccess = { kind: "github-pat", token: "t", localRemote: true };

  test("a refresh retires every other kind's mirror and the legacy one, keeping their directories", async () => {
    expect(await refresh()).toBe("built");
    // What a backend before access kinds left: one mirror every container read.
    const legacy = path.join(projectDir(), "mount");
    await fs.mkdir(legacy, { mode: 0o755 });
    await fs.cp(mirrorPath(), path.join(legacy, "mirror.git"), { recursive: true });

    expect(await refresh({}, project(), PAT)).toBe("built");

    expect(existsSync(mirrorPath("github-pat"))).toBe(true);
    expect(existsSync(mirrorPath("anonymous"))).toBe(false);
    expect(existsSync(path.join(legacy, "mirror.git"))).toBe(false);
    // Stopped containers still name these with `-v`.
    expect(existsSync(mountPath("anonymous"))).toBe(true);
    expect(existsSync(legacy)).toBe(true);
    expect(await readState()).toMatchObject({ access: "github-pat", account: "alice" });
    expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("a change of kind rebuilds at once, inside the refresh interval", async () => {
    let clock = 1_000_000;
    const options = { force: false, now: () => clock };
    expect(await refresh(options)).toBe("built");
    clock += 1;

    expect(await refresh(options, project(), PAT)).toBe("built");
    expect(await refresh(options, project(), PAT)).toBe("skipped-recent");
    expect(await refresh(options)).toBe("built");
    expect(existsSync(mirrorPath("github-pat"))).toBe(false);
  });

  test("a token for another account under the same setting withdraws the mirror before fetching", async () => {
    let clock = 1_000_000;
    expect(await refresh({ force: false, now: () => clock }, project(), PAT)).toBe("built");
    clock += 1;
    let mirrorDuringFetch: boolean | undefined;
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) mirrorDuringFetch ??= existsSync(mirrorPath("github-pat"));
      return runCommand(command, args, options);
    };

    expect(
      await refresh(
        { force: false, now: () => clock, run, accountLogin: async () => "bob" },
        project(),
        PAT,
      ),
    ).toBe("built");

    expect(mirrorDuringFetch).toBe(false);
    expect(await readState()).toMatchObject({ access: "github-pat", account: "bob" });
  });

  test("the same account keeps its mirror and the refresh interval", async () => {
    let clock = 1_000_000;
    const options = { force: false, now: () => clock };
    expect(await refresh(options, project(), PAT)).toBe("built");
    clock += 1;

    expect(await refresh(options, project(), PAT)).toBe("skipped-recent");
    expect(existsSync(mirrorPath("github-pat"))).toBe(true);
  });

  test("an account that cannot be read withdraws the mirror until a refresh can rebuild it", async () => {
    let clock = 1_000_000;
    expect(await refresh({ force: false, now: () => clock }, project(), PAT)).toBe("built");
    clock += 1;
    const unreadable = { force: false, now: () => clock, accountLogin: async () => undefined };

    expect(await refresh(unreadable, project(), PAT)).toBe("skipped-recent");
    expect(existsSync(mirrorPath("github-pat"))).toBe(false);

    clock += GIT_MIRROR_REFRESH_INTERVAL_MS;
    expect(await refresh(unreadable, project(), PAT)).toBe("failed");
    expect(await readState()).toMatchObject({ account: null });
    // Known again: whatever the unreadable one was, this is fetched anew.
    expect(await refresh({ force: false, now: () => clock }, project(), PAT)).toBe("built");
    expect(await readState()).toMatchObject({ account: "alice" });
  });

  test("anonymous access reads no account", async () => {
    let read = false;
    expect(
      await refresh({
        accountLogin: async () => {
          read = true;
          return "alice";
        },
      }),
    ).toBe("built");
    expect(read).toBe(false);
    expect(await readState()).not.toHaveProperty("account");
  });
});
