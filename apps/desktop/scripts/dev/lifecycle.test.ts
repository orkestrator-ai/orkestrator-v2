import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile, statusManifestPath } from "../../electron/runtime-profile.js";
import { parseDevArguments } from "./arguments.js";
import {
  assertElectronReadiness,
  compileElectronForDevelopment,
  startDevelopment,
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
});
