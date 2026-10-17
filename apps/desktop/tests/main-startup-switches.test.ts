import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
        const boundary = new Error("startup boundary");
        mock.module("electron", () => ({
          app: {
            setName() {},
            setDesktopName() {},
            commandLine: { appendSwitch(name) { calls.push(name); } },
            setPath() { throw boundary; },
            whenReady() { throw new Error("readiness reached before startup boundary"); },
          },
          BrowserWindow: {}, clipboard: {}, ClipboardItem: {}, dialog: {},
          ipcMain: {}, Menu: {}, nativeImage: {}, net: {}, safeStorage: {},
          session: {}, shell: {}, WebContentsView: {},
        }));
        let stopped = false;
        try {
          await import(${JSON.stringify(fileURLToPath(new URL("../electron/main.ts", import.meta.url)))});
        } catch (error) {
          if (error !== boundary) throw error;
          stopped = true;
        }
        if (!stopped) throw new Error("startup boundary was not reached");
        process.stdout.write(JSON.stringify(calls));
      `;
      const output = execFileSync(process.execPath, ["--eval", source], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 64 * 1024,
      });
      expect(JSON.parse(output)).toEqual(switches);
    });
  }
});
