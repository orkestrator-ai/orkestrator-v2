import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import {
  standaloneLayout,
  releaseDirectory,
  writeServiceConfig,
} from "@orkestrator/protocol/node/standalone-service";
import path from "node:path";
import { serviceManagerCommands, serviceUnit } from "../src/client/service-units.js";
import { createSandbox, type ClientSandbox } from "./support/client-harness.js";

const sandboxes: ClientSandbox[] = [];
afterEach(async () => {
  for (const box of sandboxes.splice(0)) await box.cleanup();
});

const base = {
  dataDir: "/home/me/.config/orkestrator-v2",
  defaultDataDir: "/home/me/.config/orkestrator-v2",
  bun: "/home/me/.bun/bin/bun",
  launcher: "/home/me/.config/orkestrator-v2/backend/launcher.js",
  logFile: "/home/me/.config/orkestrator-v2/backend/logs/service.log",
  env: { PATH: "/usr/bin:/bin" },
  home: "/home/me",
};

describe("service units", () => {
  test("a launchd agent runs the launcher, restarts it, and logs to the data directory", () => {
    const unit = serviceUnit({ ...base, platform: "darwin" });
    expect(unit).toMatchObject({
      manager: "launchd",
      name: "ai.orkestrator.backend",
      file: "/home/me/Library/LaunchAgents/ai.orkestrator.backend.plist",
    });
    expect(unit.contents).toContain(`<string>${base.bun}</string>`);
    expect(unit.contents).toContain(`<string>${base.launcher}</string>`);
    expect(unit.contents).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(unit.contents).toContain(`<string>${base.logFile}</string>`);
  });

  test("a systemd user unit quotes its words and restarts always", () => {
    const unit = serviceUnit({
      ...base,
      platform: "linux",
      dataDir: "/data/with space",
      env: { PATH: "/usr/bin", XDG_CONFIG_HOME: "/home/me/.cfg" },
    });
    expect(unit.manager).toBe("systemd");
    // A second data directory gets its own unit.
    expect(unit.name).toMatch(/^orkestrator-backend-[0-9a-f]{8}\.service$/);
    expect(unit.file).toBe(path.join("/home/me/.cfg/systemd/user", unit.name));
    expect(unit.contents).toContain(
      `ExecStart="${base.bun}" "${base.launcher}" "/data/with space"`,
    );
    expect(unit.contents).toContain("Restart=always");
  });

  test("names the load, unload and status commands per manager", () => {
    const launchd = serviceManagerCommands(
      { manager: "launchd", name: "ai.orkestrator.backend", file: "/x.plist" },
      501,
    );
    expect(launchd.load.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", "/x.plist"]);
    expect(launchd.status).toEqual(["launchctl", "print", "gui/501/ai.orkestrator.backend"]);
    const systemd = serviceManagerCommands({
      manager: "systemd",
      name: "orkestrator-backend.service",
      file: "/u",
    });
    expect(systemd.load).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "orkestrator-backend.service",
    ]);
  });
});

describe("orkestrator service", () => {
  test("install --dry-run shows the release, Bun and unit without writing anything", async () => {
    const box = await createSandbox();
    sandboxes.push(box);
    const dataDir = path.join(box.root, "data");
    const result = await box.run([
      "service",
      "install",
      "--data-dir",
      dataDir,
      "--release",
      "2.22.0",
      "--dry-run",
      "--output",
      "json",
      "--",
      "--tailscale-serve",
    ]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out) as {
      result: {
        dryRun: boolean;
        version: string;
        args: string[];
        release: string;
        unitContents: string;
      };
    };
    expect(output.result).toMatchObject({
      dryRun: true,
      version: "2.22.0",
      args: ["--tailscale-serve"],
    });
    expect(output.result.release).toBe(path.join(dataDir, "backend", "releases", "2.22.0"));
    expect(output.result.unitContents).toContain(path.join(dataDir, "backend", "launcher.js"));
  });

  test("refuses serve flags the launcher owns", async () => {
    const box = await createSandbox();
    sandboxes.push(box);
    const result = await box.run([
      "service",
      "install",
      "--dry-run",
      "--data-dir",
      path.join(box.root, "data"),
      "--",
      "--data-dir",
      "/elsewhere",
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("set by the service");
  });

  test("status reports a data directory with no service", async () => {
    const box = await createSandbox();
    sandboxes.push(box);
    const result = await box.run([
      "service",
      "status",
      "--data-dir",
      path.join(box.root, "data"),
      "--output",
      "json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).result).toMatchObject({
      installed: false,
      running: false,
      current: null,
      rollback: null,
    });
  });
});

test.each(["1.0.0", "2.0.0"])(
  "status reports effective arguments when previous is %s",
  async (previous) => {
    const box = await createSandbox();
    sandboxes.push(box);
    const dataDir = path.join(box.root, "data");
    const layout = standaloneLayout(dataDir);
    await mkdir(layout.root, { recursive: true });
    await writeServiceConfig(layout, {
      version: 1,
      dataDir,
      bun: process.execPath,
      bunVersion: Bun.version,
      args: ["--new-flag"],
      rollbackTarget: { version: "1.0.0", args: ["--host", "100.64.0.1"] },
      installedAt: "",
    });
    await symlink(releaseDirectory(layout, "1.0.0"), layout.current);
    await symlink(releaseDirectory(layout, previous), layout.previous);
    const result = await box.run(["service", "status", "--data-dir", dataDir, "--output", "json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).result.args).toEqual(
      previous === "1.0.0" ? ["--host", "100.64.0.1"] : ["--new-flag"],
    );
  },
);
