import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackendProcess } from "../electron/backend-process";
import { agentToolsPortForRuntime } from "../electron/runtime-profile";

describe("Electron profile agent tools port handoff", () => {
  test("only agent-test profiles supply a port, including legacy and absent profiles", () => {
    expect(agentToolsPortForRuntime("agent-test", { agentToolsPort: 31504 })).toBe(31504);
    expect(agentToolsPortForRuntime("development", { agentToolsPort: 31504 })).toBeUndefined();
    expect(agentToolsPortForRuntime("production", { agentToolsPort: 31504 })).toBeUndefined();
    expect(agentToolsPortForRuntime("agent-test", {})).toBeUndefined();
    expect(agentToolsPortForRuntime("agent-test", null)).toBeUndefined();
    expect(agentToolsPortForRuntime("production", undefined)).toBeUndefined();
  });

  for (const flavor of ["agent-test", "development", "production"] as const) {
    test(`supervised child receives the profile port only for agent-test (${flavor})`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-port-handoff-"));
      const backend = new BackendProcess();
      try {
        await mkdir(path.join(root, "bin"));
        await mkdir(path.join(root, "backend"));
        await symlink(process.execPath, path.join(root, "bin", "bun"));
        // Capture the real spawn arguments without starting a backend, binding
        // any ports, or accessing application data. Exiting ends the handshake.
        const marker = path.join(root, "argv.json");
        await writeFile(
          path.join(root, "backend", "main.js"),
          `await Bun.write(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
        );
        await expect(
          backend.start({
            isDev: false,
            appRoot: root,
            resourceRoot: root,
            dataDir: root,
            gatewayPort: 0,
            agentToolsPort: agentToolsPortForRuntime(flavor, { agentToolsPort: 31504 }),
            onEvent: () => undefined,
          }),
        ).rejects.toThrow();
        const argv: string[] = JSON.parse(await readFile(marker, "utf8"));
        const index = argv.indexOf("--agent-tools-port");
        if (flavor === "agent-test") {
          expect(index).toBeGreaterThanOrEqual(0);
          expect(argv[index + 1]).toBe("31504");
          expect(argv.filter((arg) => arg === "--agent-tools-port")).toHaveLength(1);
        } else {
          expect(index).toBe(-1);
          expect(argv).not.toContain("31504");
        }
      } finally {
        backend.stop();
        await rm(root, { recursive: true, force: true });
      }
    }, 15_000);
  }
});
