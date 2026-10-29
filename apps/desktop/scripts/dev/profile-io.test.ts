import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import * as profileIo from "./profile-io.js";
import { parseAgentTestArguments } from "./arguments.js";

import {
  parseRuntimeStatusManifest,
  resolveRuntimeProfile,
  statusManifestPath,
} from "../../electron/runtime-profile.js";
import type { ToolchainArtifact } from "@orkestrator/toolchain/manifest";
import {
  atomicWriteJson,
  initializeProfile,
  processMatches,
  processStartTime,
  isRemovedProfileSkeleton,
  readAndValidateSentinel,
  removeProfileState,
  reserveLoopbackPorts,
  restrictGrokAuthSnapshot,
  restrictCodexAuthSnapshot,
  restrictOpenCodeAuthSnapshot,
  CODEX_SNAPSHOT_REFRESH_TOKEN_PREFIX,
  agentTestCursorSnapshotPath,
  seedAgentTestProviderCredentials,
  seedInstalledAgentToolchains,
  seedInstalledModelCatalogCaches,
} from "./profile-io.js";
import { agentTestHostCursorCredentialPath } from "../../../backend/src/core/agent-test-cursor-credential.js";
import {
  createBoundedLogWriter,
  orphanedRuntimeProcesses,
  seedAgentTestProfileState,
  startDevelopment,
  stoppedRuntimeStatusIfUnchanged,
  stopTrackedRuntimeProcesses,
} from "./lifecycle.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

async function restrictedCredentialFixture(provider: "codex" | "opencode") {
  const fixture = await modelCacheFixture();
  const env = {
    CODEX_HOME: path.join(fixture.root, "host-codex"),
    XDG_DATA_HOME: path.join(fixture.root, "host-data"),
  };
  const source =
    provider === "codex"
      ? path.join(env.CODEX_HOME, "auth.json")
      : path.join(env.XDG_DATA_HOME, "opencode", "auth.json");
  const destination = path.join(
    fixture.profile.dataDir,
    "agent-credentials",
    ...(provider === "codex" ? ["codex"] : ["xdg-data", "opencode"]),
    "auth.json",
  );
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(
    source,
    JSON.stringify(
      provider === "codex"
        ? { OPENAI_API_KEY: "host-secret" }
        : {
            unchanged: { type: "api", key: "host-secret" },
            changed: { type: "api", key: "host-secret-2" },
          },
    ),
  );
  const enabled = { ...fixture.profile, credentialSources: [provider] };
  await seedAgentTestProviderCredentials(enabled, { roots: fixture.roots, env });
  expect(await readFile(`${destination}.orkestrator-host-snapshot`, "utf8")).not.toContain(
    "host-secret",
  );
  return {
    ...fixture,
    enabled,
    env,
    source,
    destination,
    marker: `${destination}.orkestrator-host-snapshot`,
  };
}

function runtimeStatus() {
  return {
    version: 1 as const,
    status: "ready" as const,
    profile: "qa",
    flavor: "agent-test" as const,
    dataDir: "/tmp/data",
    electronTitle: "Orkestrator AI — DEV [qa]",
    rendererUrl: "http://127.0.0.1:1",
    logDir: "/tmp/logs",
    statusPath: "/tmp/status.json",
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    pids: { launcher: 11, vite: 22, electron: 33, backend: 44 },
    processStartTimes: { launcher: 1, vite: 2, electron: 3, backend: 4 },
  };
}

async function modelCacheFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-profile-caches-"));
  directories.push(root);
  const roots = {
    developmentRoot: path.join(root, "dev"),
    productionDataDir: path.join(root, "production"),
    homeDir: path.join(root, "home"),
  };
  const profile = resolveRuntimeProfile({
    repositoryRoot: path.join(root, "repo"),
    requestedId: "qa",
    roots,
  });
  await initializeProfile(profile);
  await mkdir(roots.productionDataDir, { recursive: true });
  await mkdir(path.join(roots.homeDir, ".codex", "orkestrator-bridge"), { recursive: true });
  await mkdir(path.join(roots.homeDir, ".grok"), { recursive: true });
  return {
    root,
    roots,
    profile,
    sources: {
      agent: path.join(roots.productionDataDir, "agent-model-catalog.json"),
      opencode: path.join(roots.productionDataDir, "opencode-model-catalog.json"),
      codex: path.join(roots.homeDir, ".codex", "models_cache.json"),
      bridge: path.join(roots.homeDir, ".codex", "orkestrator-bridge", "models-cache.json"),
      grok: path.join(roots.homeDir, ".grok", "models_cache.json"),
    },
    destinations: {
      agent: path.join(profile.dataDir, "agent-model-catalog.json"),
      opencode: path.join(profile.dataDir, "opencode-model-catalog.json"),
      codex: path.join(profile.dataDir, "agent-credentials", "codex", "models_cache.json"),
      bridge: path.join(
        profile.dataDir,
        "agent-credentials",
        "codex",
        "orkestrator-bridge",
        "models-cache.json",
      ),
      grok: path.join(profile.dataDir, "agent-credentials", "home", ".grok", "models_cache.json"),
    },
  };
}

describe("development profile lifecycle primitives", () => {
  test("serializes bounded log writes and rotates without rereading the log", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-bounded-log-"));
    directories.push(root);
    const logPath = path.join(root, "vite.log");
    const writer = createBoundedLogWriter(logPath, 8);

    await Promise.all([writer.write("aaaaaa"), writer.write("bbbb"), writer.write("0123456789")]);

    expect(await readFile(logPath, "utf8")).toBe("23456789");
    expect(await readFile(`${logPath}.1`, "utf8")).toBe("bbbb");
    expect((await stat(logPath)).size).toBeLessThanOrEqual(8);
    expect((await stat(`${logPath}.1`)).size).toBeLessThanOrEqual(8);
  });

  test("creates owner-only profile metadata and a matching sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-profile-io-"));
    directories.push(root);
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.join(root, "repo"),
      requestedId: "qa",
      roots,
    });
    const profilePath = await initializeProfile(profile);
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    await expect(readAndValidateSentinel(profile, roots)).resolves.toEqual({
      version: 1,
      profile: "qa",
    });
  });

  test("removes a worktree folder kept outside the profile only while it is the profile's", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-profile-trees-"));
    directories.push(root);
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
    const resolve = (requestedId: string) =>
      resolveRuntimeProfile({
        repositoryRoot: path.join(root, "repo"),
        requestedId,
        roots,
        worktreeRoot: path.join(root, "trees"),
      });
    const owned = resolve("qa");
    await initializeProfile(owned);
    await mkdir(path.join(owned.worktreeDir, "app-feature"), { recursive: true });

    await removeProfileState(owned, false);
    expect(
      await access(owned.worktreeDir).then(
        () => true,
        () => false,
      ),
    ).toBe(false);

    // A folder whose sentinel names another profile is left alone.
    const other = resolve("other");
    await initializeProfile(other);
    await writeFile(
      path.join(other.worktreeDir, ".orkestrator-dev-worktrees"),
      JSON.stringify({ version: 1, profile: "someone-else" }),
    );
    await expect(removeProfileState(other, false)).rejects.toThrow("sentinel");
    await expect(access(other.worktreeDir)).resolves.toBeNull();
  });

  test("full profile reset unlinks legacy Keychain state without touching the host", async () => {
    const { root, profile } = await modelCacheFixture();
    const hostKeychains = path.join(root, "host-keychains");
    await mkdir(hostKeychains, { recursive: true });
    await writeFile(path.join(hostKeychains, "login.keychain-db"), "host-login");
    const target = path.join(profile.dataDir, "agent-credentials", "home", "Library", "Keychains");
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(hostKeychains, target);

    await removeProfileState(profile, false);

    expect(await isRemovedProfileSkeleton(profile.profileRoot)).toBe(true);
    await expect(readFile(path.join(hostKeychains, "login.keychain-db"), "utf8")).resolves.toBe(
      "host-login",
    );
  });

  // Docker Desktop on macOS can refuse every bind under a directory it has
  // looked up once that directory is deleted and recreated (todo 0200).
  for (const keepToolchains of [false, true]) {
    test(`${keepToolchains ? "toolchain-preserving" : "full"} reset keeps the directories on every bind source's path`, async () => {
      const { roots, profile } = await modelCacheFixture();
      const inputs = path.join(profile.dataDir, "portable-inputs");
      const staged = path.join(inputs, "0".repeat(32), "revision-1", "claude-config");
      await mkdir(staged, { recursive: true });
      await writeFile(path.join(staged, "settings.json"), "{}");
      await mkdir(path.join(profile.dataDir, "mcp-environment-overlays"), { recursive: true });
      await mkdir(path.join(profile.dataDir, "toolchains"), { recursive: true });
      const kept = [profile.profileRoot, profile.dataDir, inputs];
      const before = await Promise.all(kept.map(async (directory) => (await stat(directory)).ino));

      await removeProfileState(profile, keepToolchains);

      expect(await Promise.all(kept.map(async (directory) => (await stat(directory)).ino))).toEqual(
        before,
      );
      expect(await readdir(inputs)).toEqual([]);
      expect((await readdir(profile.dataDir)).sort()).toEqual(
        keepToolchains ? ["portable-inputs", "toolchains"] : ["portable-inputs"],
      );
      expect((await readdir(profile.profileRoot)).sort()).toEqual(
        keepToolchains ? [".orkestrator-dev-profile", "data", "profile.json"] : ["data"],
      );
      expect(await isRemovedProfileSkeleton(profile.profileRoot)).toBe(!keepToolchains);

      // The same name starts again over what was kept.
      await initializeProfile(profile);
      await expect(readAndValidateSentinel(profile, roots)).resolves.toBeTruthy();
    });
  }

  for (const keepToolchains of [false, true]) {
    for (const child of ["data", "portable-inputs"]) {
      test(`${keepToolchains ? "toolchain-preserving" : "full"} reset unlinks a pre-existing ${child} symlink`, async () => {
        const { root, profile } = await modelCacheFixture();
        const outside = path.join(root, "outside");
        await mkdir(outside, { recursive: true });
        await writeFile(path.join(outside, "precious.txt"), "unrelated");
        const target = child === "data" ? profile.dataDir : path.join(profile.dataDir, child);
        await rm(target, { recursive: true, force: true });
        await symlink(outside, target);

        await removeProfileState(profile, keepToolchains);

        await expect(readFile(path.join(outside, "precious.txt"), "utf8")).resolves.toBe(
          "unrelated",
        );
        await expect(fs.lstat(target)).rejects.toThrow();
      });
    }

    for (const phase of ["checked", "enumerated", "before-delete"] as const) {
      for (const child of ["data", "portable-inputs"]) {
        test(`${keepToolchains ? "toolchain-preserving" : "full"} reset aborts when ${child} changes at ${phase}`, async () => {
          const { root, profile } = await modelCacheFixture();
          const inputs = path.join(profile.dataDir, "portable-inputs");
          await mkdir(inputs);
          await writeFile(path.join(inputs, "precious.txt"), "profile-input");
          const target = child === "data" ? profile.dataDir : inputs;
          const outside = path.join(root, "outside");
          // Mirror the selected names so a traversal through the replacement
          // would actually delete an external file, including via data's child.
          const outsideInputs = child === "data" ? path.join(outside, "portable-inputs") : outside;
          await mkdir(outsideInputs, { recursive: true });
          await writeFile(path.join(outsideInputs, "precious.txt"), "external-input");
          let replaced = false;

          await expect(
            removeProfileState(profile, keepToolchains, {
              onDirectory: async (directory, currentPhase) => {
                if (directory !== target || phase !== currentPhase || replaced) return;
                replaced = true;
                await rename(target, path.join(root, "original"));
                await symlink(outside, target);
              },
            }),
          ).rejects.toThrow("symlink");

          expect(replaced).toBe(true);
          expect(await readFile(path.join(outsideInputs, "precious.txt"), "utf8")).toBe(
            "external-input",
          );
          const originalInput = path.join(
            root,
            "original",
            ...(child === "data" ? ["portable-inputs"] : []),
            "precious.txt",
          );
          expect(await readFile(originalInput, "utf8")).toBe("profile-input");
        });
      }
    }

    for (const replacement of ["symlink", "directory"] as const) {
      test(`${keepToolchains ? "toolchain-preserving" : "full"} reset detects an ancestor replaced by a ${replacement} during child traversal`, async () => {
        const { root, profile } = await modelCacheFixture();
        const inputs = path.join(profile.dataDir, "portable-inputs");
        await mkdir(inputs);
        await writeFile(path.join(inputs, "keep"), "original");
        const outside = path.join(root, "outside");
        await mkdir(path.join(outside, "portable-inputs"), { recursive: true });
        await writeFile(path.join(outside, "portable-inputs", "keep"), "external");
        let replaced = false;
        await expect(
          removeProfileState(profile, keepToolchains, {
            onDirectory: async (directory, phase) => {
              if (directory !== inputs || phase !== "enumerated") return;
              replaced = true;
              await rename(profile.dataDir, path.join(root, "original"));
              if (replacement === "symlink") await symlink(outside, profile.dataDir);
              else {
                await mkdir(path.join(profile.dataDir, "portable-inputs"), { recursive: true });
                await writeFile(
                  path.join(profile.dataDir, "portable-inputs", "keep"),
                  "replacement",
                );
              }
            },
          }),
        ).rejects.toThrow(replacement === "symlink" ? "symlink" : "ancestor changed");
        expect(replaced).toBe(true);
        expect(await readFile(path.join(root, "original", "portable-inputs", "keep"), "utf8")).toBe(
          "original",
        );
        expect(await readFile(path.join(outside, "portable-inputs", "keep"), "utf8")).toBe(
          "external",
        );
        if (replacement === "directory")
          expect(
            await readFile(path.join(profile.dataDir, "portable-inputs", "keep"), "utf8"),
          ).toBe("replacement");
      });
    }
  }

  test("toolchain-preserving reset uses the same symlink-safe deletion path", async () => {
    const { root, profile } = await modelCacheFixture();
    const toolchain = path.join(profile.dataDir, "toolchains", "grok");
    await mkdir(path.dirname(toolchain), { recursive: true });
    await writeFile(toolchain, "managed-toolchain");
    const hostKeychains = path.join(root, "host-keychains");
    await mkdir(hostKeychains, { recursive: true });
    await writeFile(path.join(hostKeychains, "login.keychain-db"), "host-login");
    const target = path.join(profile.dataDir, "agent-credentials", "home", "Library", "Keychains");
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(hostKeychains, target);

    await removeProfileState(profile, true);

    await expect(readFile(toolchain, "utf8")).resolves.toBe("managed-toolchain");
    expect(
      await access(target).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await expect(readFile(path.join(hostKeychains, "login.keychain-db"), "utf8")).resolves.toBe(
      "host-login",
    );
  });

  test("copies stable missing model catalogue caches with owner-only permissions", async () => {
    const { roots, profile, sources, destinations } = await modelCacheFixture();
    await writeFile(sources.agent, "agent-cache");
    await writeFile(sources.opencode, "opencode-cache");
    await writeFile(sources.codex, "codex-cache");
    await writeFile(sources.bridge, "bridge-cache");
    await writeFile(sources.grok, "grok-cache");

    await expect(seedInstalledModelCatalogCaches(profile, { roots, env: {} })).resolves.toEqual([
      "agent-model-catalog.json",
      "opencode-model-catalog.json",
      "codex/models_cache.json",
      "codex/orkestrator-bridge/models-cache.json",
      "grok/models_cache.json",
    ]);
    expect(await readFile(destinations.agent, "utf8")).toBe("agent-cache");
    expect(await readFile(destinations.opencode, "utf8")).toBe("opencode-cache");
    expect(await readFile(destinations.codex, "utf8")).toBe("codex-cache");
    expect(await readFile(destinations.bridge, "utf8")).toBe("bridge-cache");
    expect(await readFile(destinations.grok, "utf8")).toBe("grok-cache");
    for (const destination of Object.values(destinations)) {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
  });

  test("seeds catalogues from the production database and never into a profile database", async () => {
    const { Database } = await import("bun:sqlite");
    const { roots, profile, destinations } = await modelCacheFixture();
    // The minimal on-disk shape the backend writes (see @orkestrator/protocol/node/storage-database).
    const production = new Database(path.join(roots.productionDataDir, "orkestrator.sqlite"), {
      create: true,
    });
    production.exec(`
      CREATE TABLE stores (name TEXT PRIMARY KEY, revision INTEGER, layout TEXT, mode TEXT, document TEXT, updated_at INTEGER);
      CREATE TABLE store_rows (store TEXT, collection TEXT, key TEXT, position INTEGER, owner TEXT, value TEXT);
    `);
    production
      .query("INSERT INTO stores VALUES ('agent-model-catalog', 1, 'document', 'document', ?, 0)")
      .run(JSON.stringify({ schemaVersion: 1, codex: { updatedAt: "x", models: [] } }));
    production
      .query("INSERT INTO stores VALUES ('opencode-model-catalog', 1, 'envelope', 'rows', ?, 0)")
      .run(JSON.stringify({ schemaVersion: 2, catalogs: "\u0000collection" }));
    production
      .query(
        "INSERT INTO store_rows VALUES ('opencode-model-catalog', 'catalogs', 'p1', 0, NULL, ?)",
      )
      .run(JSON.stringify({ projectId: "p1" }));
    production.close();

    await expect(seedInstalledModelCatalogCaches(profile, { roots, env: {} })).resolves.toEqual([
      "agent-model-catalog.json",
      "opencode-model-catalog.json",
    ]);
    expect(JSON.parse(await readFile(destinations.agent, "utf8"))).toEqual({
      schemaVersion: 1,
      codex: { updatedAt: "x", models: [] },
    });
    expect(JSON.parse(await readFile(destinations.opencode, "utf8"))).toEqual({
      schemaVersion: 2,
      catalogs: { p1: { projectId: "p1" } },
    });
    expect((await stat(destinations.opencode)).mode & 0o777).toBe(0o600);

    // Once the profile's backend has its own database, it owns its catalogues.
    await rm(destinations.agent);
    await writeFile(path.join(profile.dataDir, "orkestrator.sqlite"), "");
    await expect(seedInstalledModelCatalogCaches(profile, { roots, env: {} })).resolves.toEqual([]);
    expect(
      await access(destinations.agent).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("preserves profile-local catalogue updates when a profile is seeded again", async () => {
    const { roots, profile, sources, destinations } = await modelCacheFixture();
    for (const source of Object.values(sources)) await writeFile(source, "initial-host-cache");
    await seedInstalledModelCatalogCaches(profile, { roots, env: {} });
    for (const destination of Object.values(destinations))
      await writeFile(destination, "profile-live-cache");
    for (const source of Object.values(sources)) await writeFile(source, "new-host-cache");

    await expect(seedInstalledModelCatalogCaches(profile, { roots, env: {} })).resolves.toEqual([]);
    for (const destination of Object.values(destinations)) {
      expect(await readFile(destination, "utf8")).toBe("profile-live-cache");
    }
  });

  test("copies only an explicitly enabled Grok credential and refreshes it on restart", async () => {
    const { roots, profile } = await modelCacheFixture();
    const source = path.join(roots.homeDir, ".grok", "auth.json");
    const destination = path.join(
      profile.dataDir,
      "agent-credentials",
      "home",
      ".grok",
      "auth.json",
    );
    const nowMs = Date.parse("2026-10-18T00:00:00Z");
    const login = (key: string) =>
      JSON.stringify({
        "https://auth.x.ai::account": {
          key,
          auth_mode: "oidc",
          refresh_token: `refresh-${key}`,
          expires_at: "2026-10-18T06:00:00Z",
        },
      });
    await writeFile(source, login("host-auth-v1"));

    await expect(seedAgentTestProviderCredentials(profile, { roots, nowMs })).resolves.toEqual([]);
    await expect(readFile(destination)).rejects.toThrow();

    const enabled = { ...profile, credentialSources: ["grok" as const] };
    await expect(seedAgentTestProviderCredentials(enabled, { roots, nowMs })).resolves.toEqual([
      "grok/auth.json",
    ]);
    const seeded = JSON.parse(await readFile(destination, "utf8"));
    expect(seeded["https://auth.x.ai::account"]).toMatchObject({
      key: "host-auth-v1",
      refresh_token: "",
    });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(destination))).toEqual(["auth.json"]);

    await writeFile(source, login("host-auth-v2"));
    await expect(seedAgentTestProviderCredentials(enabled, { roots, nowMs })).resolves.toEqual([
      "grok/auth.json",
    ]);
    expect(await readFile(destination, "utf8")).toContain("host-auth-v2");
    await seedAgentTestProviderCredentials(profile, { roots, nowMs });
    await expect(access(destination)).rejects.toThrow();
    await seedAgentTestProviderCredentials(enabled, { roots, nowMs });
    await rm(source);
    await seedAgentTestProviderCredentials(enabled, { roots, nowMs });
    await expect(access(destination)).rejects.toThrow();
  });

  test.each(["write", "rename", "read-back", "temporary cleanup"] as const)(
    "a Grok %s failure revokes the previous snapshot without blocking startup",
    async (failure) => {
      const { roots, profile } = await modelCacheFixture();
      const enabled = { ...profile, credentialSources: ["grok" as const] };
      const source = path.join(roots.homeDir, ".grok", "auth.json");
      const destination = path.join(
        profile.dataDir,
        "agent-credentials",
        "home",
        ".grok",
        "auth.json",
      );
      const hostText = JSON.stringify({ live: { key: "host-key", refresh_token: "host-refresh" } });
      await writeFile(source, hostText);
      await seedAgentTestProviderCredentials(enabled, { roots });
      const warnings: string[] = [];
      const originalRename = fs.rename;
      const injectedError = new Error("filesystem error containing host-refresh");
      const fault =
        failure === "read-back"
          ? spyOn(fs, "readFile").mockRejectedValueOnce(injectedError)
          : failure === "rename"
            ? spyOn(fs, "rename").mockImplementation(async (from, to) => {
                if (to === destination) throw injectedError;
                return originalRename(from, to);
              })
            : spyOn(fs, "writeFile").mockRejectedValueOnce(injectedError);
      const originalRm = fs.rm;
      const cleanupFault =
        failure === "temporary cleanup"
          ? spyOn(fs, "rm").mockImplementation(async (file, options) => {
              if (String(file).startsWith(`${destination}.`) && String(file).endsWith(".tmp")) {
                cleanupFault?.mockRestore();
                throw injectedError;
              }
              return originalRm(file, options);
            })
          : undefined;
      try {
        await expect(
          seedAgentTestProviderCredentials(enabled, {
            roots,
            warn: (message) => warnings.push(message),
          }),
        ).resolves.toEqual([]);
      } finally {
        fault.mockRestore();
        cleanupFault?.mockRestore();
      }
      await expect(access(destination)).rejects.toThrow();
      expect(await readdir(path.dirname(destination))).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        failure === "read-back" ? "could not be read back" : "could not be published",
      );
      expect(warnings[0]).not.toContain("host-refresh");
      expect(await readFile(source, "utf8")).toBe(hostText);
    },
  );

  test("hands a profile the host's Codex login without its refresh token, in its own CODEX_HOME", async () => {
    const { root, roots, profile } = await modelCacheFixture();
    const hostCodexHome = path.join(root, "host-codex");
    await mkdir(hostCodexHome, { recursive: true });
    const env = { CODEX_HOME: hostCodexHome };
    const source = path.join(hostCodexHome, "auth.json");
    const destination = path.join(profile.dataDir, "agent-credentials", "codex", "auth.json");
    const nowMs = Date.parse("2026-10-21T00:00:00Z");
    const accessToken = (expSeconds: number) =>
      `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
    const hostLogin = (access: string) =>
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "host-id-token",
          access_token: access,
          refresh_token: "host-single-use-refresh",
          account_id: "account-1",
        },
        last_refresh: "2026-10-11T00:00:00Z",
      });
    const live = accessToken(nowMs / 1000 + 3600);
    const hostText = hostLogin(live);
    await writeFile(source, hostText);
    const enabled = { ...profile, credentialSources: ["codex" as const] };

    await expect(seedAgentTestProviderCredentials(enabled, { roots, env, nowMs })).resolves.toEqual(
      ["codex/auth.json"],
    );
    const text = await readFile(destination, "utf8");
    expect(text).not.toContain("host-single-use-refresh");
    const seeded = JSON.parse(text);
    expect(seeded).toEqual({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "host-id-token",
        access_token: live,
        refresh_token: expect.stringMatching(new RegExp(`^${CODEX_SNAPSHOT_REFRESH_TOKEN_PREFIX}`)),
        account_id: "account-1",
      },
      last_refresh: "2026-10-21T00:00:00.000Z",
    });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await readdir(path.dirname(destination))).sort()).toEqual([
      "auth.json",
      "auth.json.orkestrator-host-snapshot",
    ]);
    // The host file is only read.
    expect(await readFile(source, "utf8")).toBe(hostText);

    // A host login that has expired is withheld, and the previous copy revoked.
    await writeFile(source, hostLogin(accessToken(nowMs / 1000 + 30)));
    const warnings: string[] = [];
    await expect(
      seedAgentTestProviderCredentials(enabled, {
        roots,
        env,
        nowMs,
        warn: (message) => warnings.push(message),
      }),
    ).resolves.toEqual([]);
    await expect(access(destination)).rejects.toThrow();
    expect(warnings).toEqual([expect.stringContaining("host Codex login has expired")]);
    expect(warnings[0]).not.toContain("host-single-use-refresh");

    // An API key is copied as an API key, and nothing else.
    await writeFile(source, JSON.stringify({ OPENAI_API_KEY: "sk-host", extra: "kept-out" }));
    await seedAgentTestProviderCredentials(enabled, { roots, env, nowMs });
    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-host",
    });

    // Revoking the source removes the snapshot it published.
    await seedAgentTestProviderCredentials(profile, { roots, env, nowMs });
    await expect(access(destination)).rejects.toThrow();
    expect(await readdir(path.dirname(destination))).toEqual([]);
  });

  test("a profile's own Codex or OpenCode login survives a profile that does not authorize the host's", async () => {
    const { root, roots, profile } = await modelCacheFixture();
    const env = {
      CODEX_HOME: path.join(root, "missing-host-codex"),
      XDG_DATA_HOME: path.join(root, "missing-host-data"),
    };
    const codex = path.join(profile.dataDir, "agent-credentials", "codex", "auth.json");
    const opencode = path.join(
      profile.dataDir,
      "agent-credentials",
      "xdg-data",
      "opencode",
      "auth.json",
    );
    for (const file of [codex, opencode]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, '{"profile":"own login"}');
    }
    // Neither authorized, nor authorized with no host login: nothing was seeded,
    // so nothing is revoked.
    await seedAgentTestProviderCredentials(profile, { roots, env });
    await seedAgentTestProviderCredentials(
      { ...profile, credentialSources: ["codex", "opencode"] },
      { roots, env },
    );
    expect(await readFile(codex, "utf8")).toBe('{"profile":"own login"}');
    expect(await readFile(opencode, "utf8")).toBe('{"profile":"own login"}');
  });

  test("hands a profile the host's OpenCode keys, never an OAuth refresh token", async () => {
    const { root, roots, profile } = await modelCacheFixture();
    const hostDataHome = path.join(root, "host-data");
    const source = path.join(hostDataHome, "opencode", "auth.json");
    await mkdir(path.dirname(source), { recursive: true });
    const destination = path.join(
      profile.dataDir,
      "agent-credentials",
      "xdg-data",
      "opencode",
      "auth.json",
    );
    const nowMs = Date.parse("2026-10-21T00:00:00Z");
    const hostText = JSON.stringify({
      "opencode-go": { type: "api", key: "go-key", note: "dropped" },
      anthropic: {
        type: "oauth",
        access: "oauth-access",
        refresh: "host-single-use-refresh",
        expires: nowMs + 3_600_000,
      },
      expired: { type: "oauth", access: "old", refresh: "old-refresh", expires: nowMs - 1 },
      unknown: { type: "future", secret: "x" },
    });
    await writeFile(source, hostText);
    const enabled = { ...profile, credentialSources: ["opencode" as const] };

    await expect(
      seedAgentTestProviderCredentials(enabled, {
        roots,
        env: { XDG_DATA_HOME: hostDataHome },
        nowMs,
      }),
    ).resolves.toEqual(["opencode/auth.json"]);
    const text = await readFile(destination, "utf8");
    expect(text).not.toContain("refresh-");
    expect(text).not.toContain("host-single-use-refresh");
    expect(JSON.parse(text)).toEqual({
      "opencode-go": { type: "api", key: "go-key" },
      anthropic: { type: "oauth", access: "oauth-access", expires: nowMs + 3_600_000, refresh: "" },
    });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(await readFile(source, "utf8")).toBe(hostText);

    await seedAgentTestProviderCredentials(profile, {
      roots,
      env: { XDG_DATA_HOME: hostDataHome },
      nowMs,
    });
    await expect(access(destination)).rejects.toThrow();
  });

  test.each(["disabled", "missing", "enabled"] as const)(
    "preserves a replacement Codex login when the host source is %s",
    async (sourceState) => {
      const { roots, profile, enabled, env, source, destination, marker } =
        await restrictedCredentialFixture("codex");
      const own = JSON.stringify({ OPENAI_API_KEY: "profile-key", auth_mode: "apikey" });
      await writeFile(destination, own);
      if (sourceState === "missing") await rm(source);
      await seedAgentTestProviderCredentials(sourceState === "disabled" ? profile : enabled, {
        roots,
        env,
      });
      expect(await readFile(destination, "utf8")).toBe(own);
      await expect(access(marker)).rejects.toThrow();
    },
  );

  test.each(["disabled", "missing", "enabled"] as const)(
    "preserves profile-owned OpenCode entries when the host source is %s",
    async (sourceState) => {
      const { roots, profile, enabled, env, source, destination, marker } =
        await restrictedCredentialFixture("opencode");
      const own = {
        changed: { type: "api", key: "profile-replacement" },
        added: { type: "api", key: "profile-added" },
      };
      const current = JSON.parse(await readFile(destination, "utf8"));
      // Provider rewrites can reorder fields; unchanged credentials still revoke.
      await writeFile(
        destination,
        JSON.stringify({ ...own, unchanged: { key: current.unchanged.key, type: "api" } }),
      );
      if (sourceState === "missing") await rm(source);
      await seedAgentTestProviderCredentials(sourceState === "disabled" ? profile : enabled, {
        roots,
        env,
      });
      const expected = sourceState === "enabled" ? { ...own, unchanged: current.unchanged } : own;
      expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(expected);
      if (sourceState === "enabled") {
        // A second restart must not claim the merged profile entries as host-owned.
        await seedAgentTestProviderCredentials(profile, { roots, env });
        expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(own);
      }
      await expect(access(marker)).rejects.toThrow();
    },
  );

  for (const provider of ["codex", "opencode"] as const) {
    test(`${provider} revocation failures abort startup before Electron compilation`, async () => {
      const { roots, profile, destination } = await restrictedCredentialFixture(provider);
      const originalRm = fs.rm;
      const injected = new Error("sensitive host-secret /private/path");
      const fault = spyOn(fs, "rm").mockImplementation(async (file, options) => {
        if (file === destination) throw injected;
        return originalRm(file, options);
      });
      const cache = spyOn(profileIo, "seedInstalledModelCatalogCaches").mockResolvedValue([]);
      const toolchains = spyOn(profileIo, "seedInstalledAgentToolchains").mockResolvedValue({
        seeded: [],
        failed: [],
      });
      let compiled = false;
      try {
        await expect(
          startDevelopment(parseAgentTestArguments(["--profile", profile.id]), "agent-test", {
            roots,
            prune: async () => [],
            typecheck: () => {
              compiled = true;
              return { status: 1 };
            },
          }),
        ).rejects.toThrow(
          `Could not revoke previous ${provider === "codex" ? "Codex" : "OpenCode"} host credentials; reset the profile before startup.`,
        );
        expect(compiled).toBe(false);
        expect(await readFile(destination, "utf8")).toContain("host-secret");
      } finally {
        fault.mockRestore();
        cache.mockRestore();
        toolchains.mockRestore();
      }
    });

    test(`${provider} unreadable ownership after publication stops startup`, async () => {
      const { roots, enabled, env, destination, marker } =
        await restrictedCredentialFixture(provider);
      const originalRename = fs.rename;
      const originalRead = fs.readFile;
      const originalRm = fs.rm;
      let published = false;
      const renameFault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await originalRename(from, to);
        if (to === destination) published = true;
      });
      // A cleanup failure requires revoking the new publication. Its ownership
      // read must fail closed too, even though auth.json remains readable.
      const cleanupFault = spyOn(fs, "rm").mockImplementation(async (file, options) => {
        if (published && file === `${destination}.host-copy`) throw new Error("host-secret");
        return originalRm(file, options);
      });
      const readFault = spyOn(fs, "readFile").mockImplementation((async (
        ...args: Parameters<typeof fs.readFile>
      ) => {
        if (published && args[0] === marker) throw new Error("host-secret");
        return originalRead(...args);
      }) as typeof fs.readFile);
      try {
        await expect(seedAgentTestProviderCredentials(enabled, { roots, env })).rejects.toThrow(
          `Could not revoke previous ${provider === "codex" ? "Codex" : "OpenCode"} host credentials; reset the profile before startup.`,
        );
        expect(published).toBe(true);
        expect(await readFile(destination, "utf8")).toContain("host-secret");
      } finally {
        renameFault.mockRestore();
        cleanupFault.mockRestore();
        readFault.mockRestore();
      }
    });

    test(`${provider} unknown ownership never deletes a profile login or permits startup`, async () => {
      const { roots, profile, env, destination, marker } =
        await restrictedCredentialFixture(provider);
      const own = JSON.stringify({ profile: "own-key" });
      await writeFile(destination, own);
      // Legacy empty markers cannot establish ownership and must be reconciled.
      await writeFile(marker, "");
      await expect(seedAgentTestProviderCredentials(profile, { roots, env })).rejects.toThrow(
        "Could not revoke previous",
      );
      expect(await readFile(destination, "utf8")).toBe(own);
    });

    test.each(["open", "read"] as const)(
      `${provider} authorized host %s errors warn without revealing contents`,
      async (operation) => {
        const { roots, enabled, env, source, destination, marker } =
          await restrictedCredentialFixture(provider);
        const originalOpen = fs.open;
        const fault = spyOn(fs, "open").mockImplementation(async (file, ...args) => {
          const handle = await originalOpen(file, ...args);
          if (file === source) {
            if (operation === "open") {
              await handle.close();
              throw new Error("host-secret /private/path");
            }
            spyOn(handle, "read").mockRejectedValue(new Error("host-secret /private/path"));
          }
          return handle;
        });
        const warnings: string[] = [];
        try {
          await expect(
            seedAgentTestProviderCredentials(enabled, {
              roots,
              env,
              warn: (message) => warnings.push(message),
            }),
          ).resolves.toEqual([]);
        } finally {
          fault.mockRestore();
        }
        expect(warnings).toEqual([
          `Could not seed ${provider === "codex" ? "Codex" : "OpenCode"} credentials in this profile: the authorized host ${provider === "codex" ? "Codex" : "OpenCode"} auth.json could not be copied.`,
        ]);
        await expect(access(destination)).rejects.toThrow();
        await expect(access(marker)).rejects.toThrow();
        expect(await readdir(path.dirname(destination))).toEqual([]);
      },
    );

    test.each(["write", "rename", "read-back"] as const)(
      `${provider} %s failure revokes the old snapshot and cleans ownership`,
      async (failure) => {
        const { roots, enabled, env, source, destination, marker } =
          await restrictedCredentialFixture(provider);
        const own =
          provider === "opencode" ? { own: { type: "api", key: "profile-key" } } : undefined;
        if (own)
          await writeFile(
            destination,
            JSON.stringify({ ...JSON.parse(await readFile(destination, "utf8")), ...own }),
          );
        const originalWrite = fs.writeFile;
        const originalRename = fs.rename;
        const originalRead = fs.readFile;
        let markerWritten = false;
        const trackMarker = spyOn(fs, "writeFile").mockImplementation(async (file, ...args) => {
          if (String(file).startsWith(`${marker}.`)) markerWritten = true;
          if (
            failure === "write" &&
            markerWritten &&
            String(file).startsWith(`${destination}.`) &&
            !String(file).startsWith(marker)
          )
            throw new Error("host-secret");
          return originalWrite(file, ...args);
        });
        const renameFault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
          if (failure === "rename" && to === destination && markerWritten)
            throw new Error("host-secret");
          return originalRename(from, to);
        });
        const readFault = spyOn(fs, "readFile").mockImplementation((async (
          ...args: Parameters<typeof fs.readFile>
        ) => {
          if (failure === "read-back" && args[0] === `${destination}.host-copy`)
            throw new Error("host-secret");
          return originalRead(...args);
        }) as typeof fs.readFile);
        const warnings: string[] = [];
        try {
          await expect(
            seedAgentTestProviderCredentials(enabled, {
              roots,
              env,
              warn: (message) => warnings.push(message),
            }),
          ).resolves.toEqual([]);
        } finally {
          trackMarker.mockRestore();
          renameFault.mockRestore();
          readFault.mockRestore();
        }
        if (own) expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(own);
        else await expect(access(destination)).rejects.toThrow();
        await expect(access(marker)).rejects.toThrow();
        expect(await readdir(path.dirname(destination))).toEqual(own ? ["auth.json"] : []);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).not.toContain("host-secret");
        expect(await readFile(source, "utf8")).toContain("host-secret");
        if (failure !== "read-back") expect(markerWritten).toBe(true);
      },
    );
  }

  test.each([-1, 30_000])(
    "Codex falls back to an API key with access expiry offset %s",
    (offset) => {
      const nowMs = Date.parse("2026-10-21T00:00:00Z");
      const access_token = `h.${Buffer.from(JSON.stringify({ exp: (nowMs + offset) / 1000 })).toString("base64url")}.s`;
      const result = restrictCodexAuthSnapshot(
        JSON.stringify({
          OPENAI_API_KEY: "api-key",
          tokens: { access_token, refresh_token: "secret" },
        }),
        nowMs,
      );
      expect("text" in result && JSON.parse(result.text)).toEqual({
        auth_mode: "apikey",
        OPENAI_API_KEY: "api-key",
      });
    },
  );

  test("OpenCode retains wellknown tokens and optional OAuth identity fields", () => {
    const result = restrictOpenCodeAuthSnapshot(
      JSON.stringify({
        known: { type: "wellknown", key: "env-key", token: "known-token", extra: "drop" },
        oauth: {
          type: "oauth",
          access: "access",
          refresh: "secret",
          expires: 120_000,
          accountId: "account",
          enterpriseUrl: "https://enterprise.example",
        },
        invalid: { type: "wellknown", key: "k", token: " " },
      }),
      0,
    );
    expect("text" in result && JSON.parse(result.text)).toEqual({
      known: { type: "wellknown", key: "env-key", token: "known-token" },
      oauth: {
        type: "oauth",
        access: "access",
        refresh: "",
        expires: 120_000,
        accountId: "account",
        enterpriseUrl: "https://enterprise.example",
      },
    });
  });

  test("Codex and OpenCode snapshot reducers refuse what they do not recognise", () => {
    expect(restrictCodexAuthSnapshot("not json")).toEqual({
      withheld: "the host Codex auth.json is not valid JSON",
    });
    expect(restrictCodexAuthSnapshot("[]")).toEqual({
      withheld: "the host Codex auth.json has an unknown shape",
    });
    expect(restrictCodexAuthSnapshot(JSON.stringify({ tokens: { refresh_token: "r" } }))).toEqual({
      withheld: "the host Codex auth.json has no API key or ChatGPT access token",
    });
    // An opaque access token has no readable expiry; it is still copied without the refresh token.
    const opaque = restrictCodexAuthSnapshot(
      JSON.stringify({ tokens: { access_token: "opaque", refresh_token: "r" } }),
      0,
    );
    expect("text" in opaque && JSON.parse(opaque.text).tokens.refresh_token).toStartWith(
      CODEX_SNAPSHOT_REFRESH_TOKEN_PREFIX,
    );
    expect(restrictOpenCodeAuthSnapshot(JSON.stringify({ a: { type: "oauth" } }))).toMatchObject({
      withheld: expect.stringContaining("no API key or unexpired login"),
    });
  });

  test("never hands a profile the host's Grok refresh token or an expired login", async () => {
    const { roots, profile } = await modelCacheFixture();
    const enabled = { ...profile, credentialSources: ["grok" as const] };
    const source = path.join(roots.homeDir, ".grok", "auth.json");
    const destination = path.join(
      profile.dataDir,
      "agent-credentials",
      "home",
      ".grok",
      "auth.json",
    );
    const nowMs = Date.parse("2026-10-18T00:00:00Z");
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    await writeFile(
      source,
      JSON.stringify({
        live: {
          key: "live-key",
          refresh_token: "live-refresh",
          expires_at: "2026-10-18T01:00:00Z",
        },
        expired: {
          key: "old-key",
          refresh_token: "old-refresh",
          expires_at: "2026-10-16T12:00:00Z",
        },
        expiring: {
          key: "soon",
          refresh_token: "soon-refresh",
          expires_at: "2026-10-18T00:00:30Z",
        },
      }),
    );
    await expect(
      seedAgentTestProviderCredentials(enabled, { roots, nowMs, warn }),
    ).resolves.toEqual(["grok/auth.json"]);
    const text = await readFile(destination, "utf8");
    expect(JSON.parse(text)).toEqual({
      live: { key: "live-key", refresh_token: "", expires_at: "2026-10-18T01:00:00Z" },
    });
    expect(text).not.toContain('refresh"');
    expect(warnings).toEqual([]);

    // Only an expired login on the host: the previous snapshot is revoked.
    await writeFile(
      source,
      JSON.stringify({
        expired: { key: "k", refresh_token: "r", expires_at: "2026-10-16T12:00:00Z" },
      }),
    );
    await expect(
      seedAgentTestProviderCredentials(enabled, { roots, nowMs, warn }),
    ).resolves.toEqual([]);
    await expect(access(destination)).rejects.toThrow();
    expect(warnings).toEqual([expect.stringContaining("the host Grok login has expired")]);
    expect(warnings[0]).not.toContain('"k"');

    for (const unreadable of ["not json", "[]", JSON.stringify({ a: { expires_at: "soon" } })]) {
      warnings.length = 0;
      await writeFile(source, unreadable);
      await expect(
        seedAgentTestProviderCredentials(enabled, { roots, nowMs, warn }),
      ).resolves.toEqual([]);
      await expect(access(destination)).rejects.toThrow();
      expect(warnings).toHaveLength(1);
      expect(await readdir(path.dirname(destination))).toEqual([]);
    }
  });

  test("restrictGrokAuthSnapshot keeps logins without an expiry but still blanks refresh", () => {
    expect(
      restrictGrokAuthSnapshot(JSON.stringify({ apiKey: { key: "k", refresh_token: "r" } })),
    ).toEqual({ text: JSON.stringify({ apiKey: { key: "k", refresh_token: "" } }) });
    expect(restrictGrokAuthSnapshot(JSON.stringify({ apiKey: { key: "k" } }))).toEqual({
      text: JSON.stringify({ apiKey: { key: "k" } }),
    });
    expect(restrictGrokAuthSnapshot("{}")).toHaveProperty("withheld");
  });

  test("snapshots only the host's effective Cursor key and revokes it on opt-out", async () => {
    const { roots, profile } = await modelCacheFixture();
    const snapshot = agentTestCursorSnapshotPath(profile);
    const config = path.join(roots.productionDataDir, "config.json");
    const login = path.join(roots.productionDataDir, "cursor-sdk", "auth.json");
    await mkdir(path.dirname(login), { recursive: true });
    const hostConfig = {
      global: { cursorApiKey: "host-config-key", githubToken: "unrelated-secret" },
    };
    await writeFile(config, JSON.stringify(hostConfig));
    const expiry = Date.now() + 60_000;
    await writeFile(
      login,
      JSON.stringify({ version: 1, apiKey: "host-minted-key", apiKeyExpiresAtMs: expiry }),
    );
    const enabled = { ...profile, credentialSources: ["cursor" as const] };

    // The stored key wins, as it does in a production backend, and nothing
    // else from the host's settings is copied.
    await expect(seedAgentTestProviderCredentials(enabled, { roots })).resolves.toEqual([
      "cursor/host-api-key.json",
    ]);
    expect(JSON.parse(await readFile(snapshot, "utf8"))).toEqual({ apiKey: "host-config-key" });
    expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(snapshot))).mode & 0o777).toBe(0o700);

    // Without a stored key, the in-app sign-in's minted key is used.
    await writeFile(config, JSON.stringify({ global: {} }));
    await seedAgentTestProviderCredentials(enabled, { roots });
    expect(JSON.parse(await readFile(snapshot, "utf8"))).toEqual({
      apiKey: "host-minted-key",
      apiKeyExpiresAtMs: expiry,
    });

    // An expired minted key is a signed-out host, so the old snapshot goes.
    await writeFile(
      login,
      JSON.stringify({ apiKey: "host-minted-key", apiKeyExpiresAtMs: Date.now() - 1 }),
    );
    await expect(seedAgentTestProviderCredentials(enabled, { roots })).resolves.toEqual([]);
    await expect(readFile(snapshot)).rejects.toThrow();

    // A profile that stops authorizing Cursor loses the snapshot.
    await writeFile(config, JSON.stringify(hostConfig));
    await seedAgentTestProviderCredentials(enabled, { roots });
    await expect(
      seedAgentTestProviderCredentials({ ...profile, credentialSources: ["grok"] }, { roots }),
    ).resolves.toEqual([]);
    await expect(readFile(snapshot)).rejects.toThrow();

    // The host's own files are only ever read.
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(hostConfig);
    // The backend reads the snapshot where this writes it.
    expect(snapshot).toBe(agentTestHostCursorCredentialPath(profile.dataDir));
  });

  test("a failed Cursor refresh removes the previous account snapshot", async () => {
    const { roots, profile } = await modelCacheFixture();
    const enabled = { ...profile, credentialSources: ["cursor" as const] };
    const config = path.join(roots.productionDataDir, "config.json");
    await mkdir(roots.productionDataDir, { recursive: true });
    await writeFile(config, JSON.stringify({ global: { cursorApiKey: "account-A" } }));
    await seedAgentTestProviderCredentials(enabled, { roots });
    const snapshot = agentTestCursorSnapshotPath(profile);
    expect(JSON.parse(await readFile(snapshot, "utf8"))).toEqual({ apiKey: "account-A" });
    await writeFile(config, JSON.stringify({ global: { cursorApiKey: "account-B" } }));
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    // Occupy the temporary file with a directory to force the atomic write to fail.
    const temporary = `${snapshot}.${process.pid}.${now}.tmp`;
    await mkdir(temporary);
    try {
      await expect(seedAgentTestProviderCredentials(enabled, { roots })).resolves.toEqual([]);
      await expect(access(snapshot)).rejects.toThrow();
      // Cleanup failure must stop startup instead of continuing with old material.
      await mkdir(snapshot);
      await expect(seedAgentTestProviderCredentials(enabled, { roots })).rejects.toThrow();
    } finally {
      clock.mockRestore();
    }
  });

  /**
   * A stand-in for one pinned artifact. Only the fields the seeder reads to
   * derive a path matter; nothing here is verified against real bytes.
   */
  function toolchainArtifact(name: "pi" | "grok", version: string): ToolchainArtifact {
    return {
      name,
      version,
      platform: "darwin",
      architecture: "arm64",
      archive: {
        format: "raw",
        url: `https://example.invalid/${name}`,
        allowedHosts: ["example.invalid"],
        entryPath: name,
        size: 1,
        sha256: "0".repeat(64),
      },
      executable: { fileName: name, size: 1, sha256: "0".repeat(64) },
    };
  }

  async function toolchainFixture(platforms: Array<"pi" | "grok">) {
    const fixture = await modelCacheFixture();
    const artifacts = [toolchainArtifact("pi", "0.84.3"), toolchainArtifact("grok", "1.0.3")];
    const hostDirectory = (name: string, version: string) =>
      path.join(fixture.roots.productionDataDir, "toolchains", name, version, "darwin-arm64");
    const profileDirectory = (name: string, version: string) =>
      path.join(fixture.profile.dataDir, "toolchains", name, version, "darwin-arm64");
    return {
      ...fixture,
      artifacts,
      hostDirectory,
      profileDirectory,
      profile: { ...fixture.profile, agentPlatforms: platforms },
    };
  }

  test("seeds selected agent toolchains from the host installation", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["pi", "grok"]);
    for (const [name, version] of [
      ["pi", "0.84.3"],
      ["grok", "1.0.3"],
    ] as const) {
      await mkdir(hostDirectory(name, version), { recursive: true });
      await writeFile(path.join(hostDirectory(name, version), name), `${name}-bytes`);
    }
    // Finder droppings would change Pi's aggregate bundle digest, which is
    // exactly the check that would then force the download this avoids.
    await writeFile(path.join(hostDirectory("pi", "0.84.3"), ".DS_Store"), "junk");

    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
      }),
    ).resolves.toEqual({ seeded: ["pi@0.84.3", "grok@1.0.3"], failed: [] });
    expect(await readFile(path.join(profileDirectory("pi", "0.84.3"), "pi"), "utf8")).toBe(
      "pi-bytes",
    );
    expect(await readFile(path.join(profileDirectory("grok", "1.0.3"), "grok"), "utf8")).toBe(
      "grok-bytes",
    );
    await expect(
      access(path.join(profileDirectory("pi", "0.84.3"), ".DS_Store")),
    ).rejects.toThrow();
  });

  test("seeds only the selected platforms and leaves the host untouched", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["grok"]);
    for (const [name, version] of [
      ["pi", "0.84.3"],
      ["grok", "1.0.3"],
    ] as const) {
      await mkdir(hostDirectory(name, version), { recursive: true });
      await writeFile(path.join(hostDirectory(name, version), name), `${name}-bytes`);
    }

    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
      }),
    ).resolves.toEqual({ seeded: ["grok@1.0.3"], failed: [] });
    await expect(access(profileDirectory("pi", "0.84.3"))).rejects.toThrow();
    // One-way: the profile never writes back into the user's real installation.
    expect(await readFile(path.join(hostDirectory("grok", "1.0.3"), "grok"), "utf8")).toBe(
      "grok-bytes",
    );
  });

  test("leaves an already-provisioned profile toolchain alone", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["grok"]);
    await mkdir(hostDirectory("grok", "1.0.3"), { recursive: true });
    await writeFile(path.join(hostDirectory("grok", "1.0.3"), "grok"), "host-bytes");
    await mkdir(profileDirectory("grok", "1.0.3"), { recursive: true });
    await writeFile(path.join(profileDirectory("grok", "1.0.3"), "grok"), "profile-bytes");

    // A running backend resolves through this directory. Re-seeding it on every
    // restart would swap the executable underneath a live session.
    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
      }),
    ).resolves.toEqual({ seeded: [], failed: [] });
    expect(await readFile(path.join(profileDirectory("grok", "1.0.3"), "grok"), "utf8")).toBe(
      "profile-bytes",
    );
  });

  test("reports nothing when the host has not installed the toolchain", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      profileDirectory,
    } = await toolchainFixture(["pi", "grok"]);

    // The installer downloads it instead. Seeding is an optimization, so a bare
    // host must not fail the profile start.
    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
      }),
    ).resolves.toEqual({ seeded: [], failed: [] });
    await expect(access(profileDirectory("grok", "1.0.3"))).rejects.toThrow();
  });

  test("refuses a symlinked host toolchain directory", async () => {
    const {
      root,
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["grok"]);
    const elsewhere = path.join(root, "elsewhere", "grok");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "grok"), "elsewhere-bytes");
    await mkdir(path.dirname(hostDirectory("grok", "1.0.3")), { recursive: true });
    // Following it would copy from a tree outside the host toolchain root, which
    // is not the installation this seeding is allowed to trust.
    await symlink(elsewhere, hostDirectory("grok", "1.0.3"));

    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
        warn: () => undefined,
      }),
    ).resolves.toEqual({ seeded: [], failed: [] });
    await expect(access(profileDirectory("grok", "1.0.3"))).rejects.toThrow();
  });

  test("reports a failed copy distinctly from a host that has nothing installed", async () => {
    const {
      roots: profileRoots,
      profile,
      artifacts,
      hostDirectory,
      profileDirectory,
    } = await toolchainFixture(["grok"]);
    await mkdir(hostDirectory("grok", "1.0.3"), { recursive: true });
    await writeFile(path.join(hostDirectory("grok", "1.0.3"), "grok"), "host-bytes");
    // A file where the version directory has to go. The copy cannot succeed, and
    // this must not look like the bare-host case, which is byte-identical in its
    // outcome — both fall through to the installer's download.
    await mkdir(path.dirname(path.dirname(profileDirectory("grok", "1.0.3"))), { recursive: true });
    await writeFile(path.dirname(profileDirectory("grok", "1.0.3")), "not-a-directory");

    const warnings: string[] = [];
    await expect(
      seedInstalledAgentToolchains(profile, {
        roots: profileRoots,
        artifacts,
        platform: "darwin",
        architecture: "arm64",
        warn: (message) => warnings.push(message),
      }),
    ).resolves.toEqual({ seeded: [], failed: ["grok@1.0.3"] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("grok@1.0.3");
    // Diagnostics name the artifact, never the filesystem paths involved.
    expect(warnings[0]).not.toContain(profileRoots.productionDataDir);
    expect(warnings[0]).not.toContain(profile.dataDir);
  });

  test("seeds nothing for a profile that provisions no platforms", async () => {
    const { roots: profileRoots, profile, artifacts, hostDirectory } = await toolchainFixture([]);
    await mkdir(hostDirectory("grok", "1.0.3"), { recursive: true });
    await writeFile(path.join(hostDirectory("grok", "1.0.3"), "grok"), "host-bytes");

    await expect(
      seedInstalledAgentToolchains(
        { ...profile, agentPlatforms: [] },
        { roots: profileRoots, artifacts, platform: "darwin", architecture: "arm64" },
      ),
    ).resolves.toEqual({ seeded: [], failed: [] });
  });

  test("seeds an agent-test profile and reports what Electron still has to download", async () => {
    const { profile } = await toolchainFixture(["pi", "grok"]);
    const logs: string[] = [];
    const warnings: string[] = [];

    const warn = (message: string) => warnings.push(message);
    await seedAgentTestProfileState(profile, "agent-test", {
      seedModelCatalogCaches: async () => [],
      seedProviderCredentials: async (receivedProfile, options) => {
        expect(receivedProfile).toBe(profile);
        expect(options?.warn).toBe(warn);
        options?.warn?.("provider snapshot withheld");
        return [];
      },
      seedAgentToolchains: async () => ({ seeded: ["pi@0.84.3"], failed: ["grok@1.0.3"] }),
      log: (message) => logs.push(message),
      warn,
    });

    expect(logs).toEqual([
      "Seeded toolchains from the host install: pi@0.84.3",
      // Attributes a slow or hung startup before Electron is even launched.
      "Electron will download managed toolchains for: grok",
    ]);
    expect(warnings).toEqual([
      "provider snapshot withheld",
      "Could not seed from the host install: grok@1.0.3",
    ]);
  });

  test("seeds nothing for an ordinary development profile", async () => {
    const { profile } = await toolchainFixture(["pi", "grok"]);
    const calls: string[] = [];

    // `dev` uses the durable per-installation state; copying host toolchains
    // into it would be provisioning a profile that does not exist.
    await seedAgentTestProfileState({ ...profile, flavor: "development" }, "development", {
      seedModelCatalogCaches: async () => {
        calls.push("caches");
        return [];
      },
      seedProviderCredentials: async () => {
        calls.push("credentials");
        return [];
      },
      seedAgentToolchains: async () => {
        calls.push("toolchains");
        return { seeded: [], failed: [] };
      },
      log: (message) => calls.push(message),
      warn: (message) => calls.push(message),
    });

    expect(calls).toEqual([]);
  });

  test("skips missing, symlinked, and oversized model cache sources", async () => {
    const { root, roots, profile, sources, destinations } = await modelCacheFixture();
    const linkedCache = path.join(root, "linked-cache.json");
    await writeFile(linkedCache, "linked-cache");
    await symlink(linkedCache, sources.opencode);
    await writeFile(sources.agent, "");
    await truncate(sources.agent, 16 * 1024 * 1024 + 1);

    await expect(seedInstalledModelCatalogCaches(profile, { roots, env: {} })).resolves.toEqual([]);
    for (const destination of Object.values(destinations)) {
      await expect(readFile(destination)).rejects.toThrow();
    }
  });

  test("rejects caches that grow or are replaced after descriptor validation", async () => {
    const { roots, profile, sources, destinations } = await modelCacheFixture();
    await writeFile(sources.agent, "agent-cache");
    await writeFile(sources.opencode, "opencode-cache");

    await expect(
      seedInstalledModelCatalogCaches(profile, {
        roots,
        env: {},
        afterSourceValidation: async (label) => {
          if (label === "agent-model-catalog.json") {
            await appendFile(sources.agent, "-changed");
          } else if (label === "opencode-model-catalog.json") {
            await rename(sources.opencode, `${sources.opencode}.old`);
            await writeFile(sources.opencode, "replacement-cache");
          }
        },
      }),
    ).resolves.toEqual([]);
    await expect(readFile(destinations.agent)).rejects.toThrow();
    await expect(readFile(destinations.opencode)).rejects.toThrow();
  });

  test("validates process identity with PID and start time", () => {
    const started = processStartTime(process.pid);
    expect(started).not.toBeNull();
    expect(processMatches(process.pid, started!)).toBe(true);
    expect(processMatches(process.pid, started! - 60_000)).toBe(false);
  });

  test("stops surviving detached processes when the launcher is already dead", async () => {
    const active = new Set([22, 33, 44]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals; processGroup: boolean }> = [];
    const status = runtimeStatus();

    await expect(
      stopTrackedRuntimeProcesses(status, {
        matches: (pid) => Boolean(pid && active.has(pid)),
        signal: (pid, signal, processGroup) => {
          signals.push({ pid, signal, processGroup });
          active.delete(pid);
          if (pid === 33) active.delete(44);
        },
        sleep: async () => undefined,
      }),
    ).resolves.toEqual([]);

    expect(signals).toEqual([
      { pid: 22, signal: "SIGTERM", processGroup: true },
      { pid: 33, signal: "SIGTERM", processGroup: true },
    ]);
    expect(active.size).toBe(0);
  });

  test("stops at the launcher when its shutdown takes the whole tree with it", async () => {
    // The launcher's own SIGTERM handler kills the Vite and Electron groups, so
    // signalling every tracked PID as well would be redundant at best and, once
    // those PIDs are recycled, aimed at something else entirely.
    const active = new Set([11, 22, 33, 44]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals; processGroup: boolean }> = [];

    await expect(
      stopTrackedRuntimeProcesses(runtimeStatus(), {
        matches: (pid) => Boolean(pid && active.has(pid)),
        signal: (pid, signal, processGroup) => {
          signals.push({ pid, signal, processGroup });
          if (pid === 11) active.clear();
        },
        sleep: async () => undefined,
      }),
    ).resolves.toEqual([]);

    expect(signals).toEqual([{ pid: 11, signal: "SIGTERM", processGroup: false }]);
  });

  test("escalates to SIGKILL and reports whatever outlives it", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let clock = 0;
    // Nothing ever exits: SIGTERM to the launcher, then SIGTERM to all four,
    // then SIGKILL to the four survivors, and the caller learns every name.
    // The clock is driven by the sleep stub so the 5s/5s/2s deadlines are
    // exercised without spending twelve real seconds on them.
    await expect(
      stopTrackedRuntimeProcesses(runtimeStatus(), {
        matches: (pid) => Boolean(pid),
        signal: (pid, signal) => void signals.push({ pid, signal }),
        sleep: async (milliseconds) => void (clock += milliseconds),
        now: () => clock,
      }),
    ).resolves.toEqual(["launcher", "vite", "electron", "backend"]);

    expect(signals.filter((entry) => entry.signal === "SIGTERM").map((entry) => entry.pid)).toEqual(
      [11, 11, 22, 33, 44],
    );
    expect(signals.filter((entry) => entry.signal === "SIGKILL").map((entry) => entry.pid)).toEqual(
      [11, 22, 33, 44],
    );
  });

  test("treats surviving processes without a launcher as orphans that block a restart", () => {
    const live = { launcher: false, vite: true, electron: false, backend: true };
    expect(orphanedRuntimeProcesses(live)).toEqual(["vite", "backend"]);
    // A live launcher owns them, so `dev` reports "already running" instead.
    expect(orphanedRuntimeProcesses({ ...live, launcher: true })).toEqual([]);
    expect(
      orphanedRuntimeProcesses({ launcher: false, vite: false, electron: false, backend: false }),
    ).toEqual([]);
    expect(orphanedRuntimeProcesses(null)).toEqual([]);
  });

  test("marks only the process snapshot it stopped as stopped", () => {
    const original = runtimeStatus();
    const stopped = stoppedRuntimeStatusIfUnchanged(original, original, "2026-08-14T12:00:00.000Z");
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.updatedAt).toBe("2026-08-14T12:00:00.000Z");

    expect(
      stoppedRuntimeStatusIfUnchanged(original, {
        ...original,
        pids: { ...original.pids, launcher: 55 },
        processStartTimes: { ...original.processStartTimes, launcher: 5 },
      }),
    ).toBeNull();
  });

  test("reserves distinct usable loopback ports", async () => {
    const [first, second] = await reserveLoopbackPorts(2);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(first).not.toBe(second);
  });

  test("status validation rejects secret-bearing or unknown fields", async () => {
    const base = {
      version: 1,
      status: "ready",
      profile: "qa",
      flavor: "agent-test",
      dataDir: "/tmp/data",
      electronTitle: "Orkestrator AI — DEV [qa]",
      rendererUrl: "http://127.0.0.1:1",
      logDir: "/tmp/logs",
      statusPath: "/tmp/status.json",
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      pids: {},
      processStartTimes: {},
    };
    expect(parseRuntimeStatusManifest(base).profile).toBe("qa");
    expect(() => parseRuntimeStatusManifest({ ...base, token: "secret" })).toThrow(
      "unsupported field",
    );

    const root = await mkdtemp(path.join(os.tmpdir(), "ork-profile-status-"));
    directories.push(root);
    const filePath = path.join(root, "status.json");
    await atomicWriteJson(filePath, base);
    expect(JSON.parse(await readFile(filePath, "utf8"))).not.toHaveProperty("token");
    expect(
      statusManifestPath(
        resolveRuntimeProfile({
          repositoryRoot: root,
          requestedId: "qa",
          roots: {
            developmentRoot: root,
            productionDataDir: path.join(root, "prod"),
            homeDir: os.tmpdir(),
          },
        }),
      ),
    ).toEndWith(path.join("runtime", "status.json"));
  });
});

describe("external profile initialization", () => {
  test("refuses unowned and conflicting destinations before writing profile state", async () => {
    const { root, roots } = await modelCacheFixture();
    for (const conflicting of [false, true]) {
      const profile = resolveRuntimeProfile({
        repositoryRoot: path.join(root, "repo"),
        roots,
        requestedId: conflicting ? "conflict" : "unowned",
        worktreeRoot: path.join(root, "trees"),
      });
      await mkdir(profile.worktreeDir, { recursive: true });
      await writeFile(path.join(profile.worktreeDir, "precious.txt"), "unrelated");
      if (conflicting)
        await writeFile(
          path.join(profile.worktreeDir, ".orkestrator-dev-worktrees"),
          JSON.stringify({ version: 1, profile: "other" }),
        );
      await expect(initializeProfile(profile)).rejects.toThrow("sentinel");
      await expect(readFile(path.join(profile.worktreeDir, "precious.txt"), "utf8")).resolves.toBe(
        "unrelated",
      );
      await expect(access(path.join(profile.profileRoot, "profile.json"))).rejects.toThrow();
      await expect(removeProfileState(profile, false)).rejects.toThrow("sentinel");
      if (conflicting)
        expect(
          JSON.parse(
            await readFile(path.join(profile.worktreeDir, ".orkestrator-dev-worktrees"), "utf8"),
          ).profile,
        ).toBe("other");
    }
  });

  test("reuses an owned destination and refuses an ancestor replaced by a symlink", async () => {
    const { root, roots } = await modelCacheFixture();
    const parent = path.join(root, "trees");
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.join(root, "repo"),
      roots,
      requestedId: "outside",
      worktreeRoot: parent,
    });
    await initializeProfile(profile);
    await writeFile(path.join(profile.worktreeDir, "keep"), "owned");
    await initializeProfile(profile);
    await rename(parent, `${parent}-original`);
    await symlink(`${parent}-original`, parent);
    await expect(initializeProfile(profile)).rejects.toThrow("symlink");
    await expect(removeProfileState(profile, false)).rejects.toThrow("symlink");
    expect(await readFile(path.join(profile.worktreeDir, "keep"), "utf8")).toBe("owned");
  });
});
