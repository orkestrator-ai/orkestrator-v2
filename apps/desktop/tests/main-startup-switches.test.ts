import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_PACKAGE_VERSION } from "../electron/app-version";

const electronDir = new URL("../electron/", import.meta.url);

/**
 * Every value the main-process sources import from "electron", so the stub
 * below keeps resolving when main gains an Electron import.
 */
function electronValueImports(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(electronDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(new URL(file, electronDir), "utf8");
    for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"electron"/g)) {
      if (match[1]) continue;
      for (const specifier of match[2]!.split(",")) {
        const name = specifier.trim().split(/\s+as\s+/)[0]!;
        if (name && !name.startsWith("type ")) names.add(name);
      }
    }
  }
  return [...names].sort();
}

describe("main process startup switches", () => {
  for (const [flavor, platform, switches] of [
    ["agent-test", "darwin", ["use-mock-keychain"]],
    ["agent-test", "linux", []],
    ["development", "darwin", []],
    ["production", "darwin", []],
  ] as const) {
    test(`${flavor} on ${platform} appends its switches during module loading`, () => {
      // Isolate Electron's module mock and process.platform from other suites.
      // Stop at setPath, before logging, locks, backend processes or windows can
      // touch user state. Moving the switch wiring past this boundary must fail.
      const source = `
        import { mock } from "bun:test";
        import net from "node:net";
        // Bun has no native setter. Supply one so startup must actually wrap
        // the shared Socket.prototype, even on runtimes without this API.
        const originalSetter = function () { return this; };
        net.Socket.prototype.setTypeOfService = originalSetter;
        const runtimePath = ${JSON.stringify(fileURLToPath(new URL("../electron/runtime-profile.ts", import.meta.url)))};
        const runtime = await import(runtimePath);
        mock.module(runtimePath, () => ({
          ...runtime,
          runtimeProfileFromEnvironment: () => ({
            flavor: ${JSON.stringify(flavor)},
            electronTitle: "Startup test",
            dataDir: "/isolated-startup-test",
          }),
        }));
        Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
        const calls = [];
        let aboutPanel;
        const boundary = new Error("startup boundary");
        mock.module("electron", () => ({
          ...Object.fromEntries(${JSON.stringify(electronValueImports())}.map((name) => [name, {}])),
          app: {
            isPackaged: false,
            getVersion() { return "45.0.0"; },
            setName() {},
            setAboutPanelOptions(options) { aboutPanel = options; },
            setDesktopName() {},
            commandLine: { appendSwitch(name) { calls.push(name); } },
            setPath() { throw boundary; },
            whenReady() { throw new Error("readiness reached before startup boundary"); },
          },
        }));
        let stopped = false;
        try {
          await import(${JSON.stringify(fileURLToPath(new URL("../electron/main.ts", import.meta.url)))});
        } catch (error) {
          if (error !== boundary) throw error;
          stopped = true;
        }
        if (!stopped) throw new Error("startup boundary was not reached");
        const installedSetter = net.Socket.prototype.setTypeOfService;
        if (installedSetter === originalSetter ||
            !installedSetter[Symbol.for("orkestrator.socketTypeOfServiceGuard")]) {
          throw new Error("socket guard was not installed before startup side effects");
        }
        process.stdout.write(JSON.stringify({ calls, aboutPanel }));
      `;
      const output = execFileSync(process.execPath, ["--eval", source], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 64 * 1024,
      });
      const result = JSON.parse(output);
      expect(result.calls).toEqual(switches);
      // Set before ready, with the profile's title and the package version,
      // not Electron's own. main.ts runs from source here rather than from
      // the emitted bundle, so only the icon's unpackaged branch is checked;
      // about-panel.test.ts pins the exact paths.
      expect(result.aboutPanel).toMatchObject({
        applicationName: "Startup test",
        applicationVersion: DESKTOP_PACKAGE_VERSION,
        version: DESKTOP_PACKAGE_VERSION,
      });
      expect(result.aboutPanel.iconPath).toEndWith(path.join("electron", "resources", "icon.png"));
    });
  }
});
