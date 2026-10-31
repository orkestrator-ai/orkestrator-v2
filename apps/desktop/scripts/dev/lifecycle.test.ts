import { describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile, statusManifestPath } from "../../electron/runtime-profile.js";
import { initializeProfile } from "./profile-io.js";
import { parseDevArguments } from "./arguments.js";
import {
  assertElectronReadiness,
  compileElectronForDevelopment,
  electronReadinessTimeoutMs,
  outputTail,
  startDevelopment,
  withOutputTails,
  configuredDevWorktreeRoot,
  profileWorktreeLocation,
} from "./lifecycle.js";

const complete = {
  authFile: "/tmp/gateway-auth.json",
  backendPid: 42,
  browserUrl: "http://x/",
  invokeUrl: "http://internal/",
};

describe("Electron readiness", () => {
  test("always requires the backend gateway", () => {
    for (const run of [
      { flavor: "development" as const, fixture: false },
      { flavor: "agent-test" as const, fixture: false },
    ]) {
      expect(() => assertElectronReadiness({ ...complete, authFile: undefined }, run)).toThrow(
        /backend gateway/,
      );
      expect(() => assertElectronReadiness({ ...complete, backendPid: undefined }, run)).toThrow(
        /backend gateway/,
      );
    }
  });

  test("a desktop dev run does not require a reported browser URL", () => {
    // `bun run dev` starts the backend with `--desktop-web-client`, which
    // deliberately omits `browserUrl`: the loopback listener is up, but its
    // authoritative public URL belongs to ManagedWebClient and can arrive after
    // readiness. Requiring it here failed every desktop dev run.
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined },
        { flavor: "development", fixture: false },
      ),
    ).not.toThrow();
  });

  test("agent-test requires it, because a browser suite has to reach the app", () => {
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined },
        { flavor: "agent-test", fixture: false },
      ),
    ).toThrow(/loopback browser gateway/);
  });

  test("a desktop fixture can use the authenticated invoke URL", () => {
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined },
        { flavor: "development", fixture: true },
      ),
    ).not.toThrow();
  });

  test("seeding a fixture still requires one reachable gateway", () => {
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined, invokeUrl: undefined },
        { flavor: "development", fixture: true },
      ),
    ).toThrow(/fixture seeding/);
  });

  test("accepts a fully populated readiness message in every mode", () => {
    for (const flavor of ["development", "agent-test"] as const) {
      for (const fixture of [false, true]) {
        expect(() => assertElectronReadiness(complete, { flavor, fixture })).not.toThrow();
      }
    }
  });

  test("waits on interactive development startup but times out agent-test runs", () => {
    // A fresh dev profile parks on the first-run platform chooser; killing it
    // after a fixed timeout meant `mise run dev` never reached the app.
    expect(electronReadinessTimeoutMs("development")).toBeNull();
    expect(electronReadinessTimeoutMs("agent-test")).toBe(60_000);
  });
});

describe("startup failure output", () => {
  // The isolated runner resets the profile, deleting electron.log and vite.log,
  // so an Electron that exits before readiness must quote its own output.
  test("quotes the latest output of both streams, bounded", () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    }) as unknown as ChildProcess;
    const tail = outputTail(child, 16);
    child.stdout!.emit("data", Buffer.from("early output\n"));
    child.stderr!.emit("data", Buffer.from("renderer failed\n"));
    // Only the newest characters are kept, whichever stream they came from.
    expect(tail()).toBe("renderer failed");
  });

  test("names each tail that has output and omits empty ones", () => {
    expect(
      withOutputTails("Electron exited before readiness (code 0, signal none)", {
        Electron: () => "No usable Codex toolchain",
        Vite: () => "",
      }),
    ).toBe(
      "Electron exited before readiness (code 0, signal none)\nElectron output tail:\nNo usable Codex toolchain",
    );
  });
});

describe("development Electron compilation", () => {
  test("type-checks before bundling and records successful output", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-dev-build-"));
    const called: string[] = [];
    try {
      await compileElectronForDevelopment(logDir, {
        typecheck: () => {
          called.push("typecheck");
          return { status: 0, stdout: "typecheck output\n" };
        },
        bundle: async () => {
          called.push("bundle");
          return {
            success: true,
            outputs: [{ path: path.join(import.meta.dir, "../../dist/electron/main.js") }],
            logs: [],
          } as unknown as Bun.BuildOutput;
        },
      });
      expect(called).toEqual(["typecheck", "bundle"]);
      expect(await readFile(path.join(logDir, "build.log"), "utf8")).toContain("typecheck output");
      expect(await readFile(path.join(logDir, "build.log"), "utf8")).toContain("main.js");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  test("a type error stops before bundling and is written to build.log", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-dev-type-error-"));
    let bundled = false;
    try {
      await expect(
        compileElectronForDevelopment(logDir, {
          typecheck: () => ({ status: 2, stderr: "electron/main.ts(1,1): error TS2322\n" }),
          bundle: async () => {
            bundled = true;
            throw new Error("bundle should not run");
          },
        }),
      ).rejects.toThrow(/Electron compilation failed/);
      expect(bundled).toBe(false);
      expect(await readFile(path.join(logDir, "build.log"), "utf8")).toContain("error TS2322");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  test("a bundle failure writes build.log and marks the profile failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-dev-bundle-error-"));
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
    const args = parseDevArguments(["--profile", "failed-bundle"]);
    const profile = resolveRuntimeProfile({
      repositoryRoot: path.resolve(import.meta.dir, "../../../.."),
      requestedId: args.profile,
      roots,
    });
    try {
      await expect(
        startDevelopment(args, "development", {
          roots,
          typecheck: () => ({ status: 0 }),
          bundle: async () =>
            ({
              success: false,
              outputs: [],
              logs: [{ level: "error", message: "broken entrypoint", position: null }],
            }) as unknown as Bun.BuildOutput,
        }),
      ).rejects.toThrow(/Electron compilation failed/);
      expect(await readFile(path.join(profile.logDir, "build.log"), "utf8")).toContain(
        "error: broken entrypoint",
      );
      const status = JSON.parse(await readFile(statusManifestPath(profile), "utf8")) as {
        status: string;
        error: string;
      };
      expect(status.status).toBe("failed");
      expect(status.error).toContain("build.log");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("start excludes its own profile and continues when pruning fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-dev-prune-error-"));
    const roots = {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    };
    const args = parseDevArguments(["--profile", "starting"]);
    const exclusions: string[][] = [];
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        startDevelopment(args, "development", {
          roots,
          prune: async (options) => {
            exclusions.push([...(options?.exclude ?? [])]);
            throw new Error("prune unavailable");
          },
          typecheck: () => ({ status: 2, stderr: "intentional compile stop" }),
        }),
      ).rejects.toThrow(/Electron compilation failed/);
      expect(exclusions).toEqual([["starting"]]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("prune unavailable"));
    } finally {
      warning.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("a new agent-test profile uses the configured dev worktree folder only when asked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-dev-location-"));
  const roots = {
    developmentRoot: path.join(root, "dev"),
    productionDataDir: path.join(root, "production"),
    homeDir: root,
  };
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  try {
    const configured = path.join(root, "trees");
    await mkdir(roots.productionDataDir, { recursive: true });
    await writeFile(
      path.join(roots.productionDataDir, "config.json"),
      JSON.stringify({ global: { worktreeLocations: { dev: configured } } }),
    );
    const profile = resolveRuntimeProfile({
      repositoryRoot,
      requestedId: "qa",
      flavor: "agent-test",
      roots,
    });
    expect(await profileWorktreeLocation(profile, roots, false)).toEqual({});
    expect(await profileWorktreeLocation(profile, roots, true)).toEqual({
      worktreeRoot: configured,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dev settings come from production and apply only to new profiles; restarts retain every stored directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-dev-location-"));
  const roots = {
    developmentRoot: path.join(root, "dev"),
    productionDataDir: path.join(root, "production"),
    homeDir: root,
  };
  const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
  try {
    const original = path.join(root, "trees-original");
    const changed = path.join(root, "trees-changed");
    await mkdir(roots.productionDataDir, { recursive: true });
    await writeFile(
      path.join(roots.productionDataDir, "config.json"),
      JSON.stringify({ global: { worktreeLocations: { dev: original } } }),
    );
    expect(await configuredDevWorktreeRoot(roots)).toBe(original);
    for (const kind of ["default", "internal", "external", "new"] as const) {
      const args = parseDevArguments(["--profile", kind]);
      const basic = resolveRuntimeProfile({ repositoryRoot, requestedId: kind, roots });
      const profile = resolveRuntimeProfile({
        repositoryRoot,
        requestedId: kind,
        roots,
        ...(kind === "internal"
          ? { worktreeDir: path.join(basic.profileRoot, "nested", "custom") }
          : {}),
        ...(kind === "external" ? { worktreeRoot: original } : {}),
      });
      if (kind !== "new") {
        await initializeProfile(profile);
        await writeFile(
          path.join(profile.dataDir, "config.json"),
          JSON.stringify({
            global: { worktreeLocations: { dev: path.join(root, "ignored-profile-setting") } },
          }),
        );
      }
      await writeFile(
        path.join(roots.productionDataDir, "config.json"),
        JSON.stringify({ global: { worktreeLocations: { dev: changed } } }),
      );
      await expect(
        startDevelopment(args, "development", {
          roots,
          prune: async () => [],
          typecheck: () => ({ status: 2, stderr: "intentional compile stop" }),
        }),
      ).rejects.toThrow("Electron compilation failed");
      const stored = JSON.parse(
        await readFile(path.join(profile.profileRoot, "profile.json"), "utf8"),
      );
      expect(stored.worktreeDir).toBe(
        kind === "new" ? path.join(changed, kind) : profile.worktreeDir,
      );
    }
    await rm(path.join(roots.productionDataDir, "config.json"));
    expect(await configuredDevWorktreeRoot(roots)).toBeUndefined();
    await writeFile(path.join(roots.productionDataDir, "config.json"), "invalid");
    expect(await configuredDevWorktreeRoot(roots)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
