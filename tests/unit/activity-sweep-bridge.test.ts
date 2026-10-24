import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, stopBridge } from "../../scripts/activity-sweep-bridge";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "activity-sweep-startup-test-"));
  roots.push(root);
  const credentialPath = join(root, "fake-auth.json");
  writeFileSync(credentialPath, '{"test":"fake-credential"}');
  return { root, credentialPath };
}
const options = { root: "/unused", codex: "/unused/codex" };

describe("activity sweep bridge ownership", () => {
  test.each(["missing credential", "spawn throws"])(
    "cleans temporary home when setup fails: %s",
    async (failure) => {
      const { root, credentialPath } = fixture();
      let spawned = false;
      await expect(
        startBridge("codex", options, {
          tempRoot: root,
          credentialPath:
            failure === "missing credential" ? join(root, "missing.json") : credentialPath,
          spawn: (() => {
            spawned = true;
            throw new Error("spawn rejected");
          }) as typeof spawn,
        }),
      ).rejects.toThrow();
      expect(spawned).toBe(failure === "spawn throws");
      expect(readdirSync(root)).toEqual(["fake-auth.json"]);
    },
  );

  test.each([false, true])(
    "readiness timeout reaps the child and removes copied credentials (ignores TERM: %s)",
    async (ignoreTerm) => {
      const { root, credentialPath } = fixture();
      let child: ChildProcess | undefined;
      let home = "";
      let checkedCredentials = false;
      let ready: Promise<void>;
      const spawnFixture = (() => {
        child = spawn(
          process.execPath,
          [
            "-e",
            `
        ${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
        setInterval(() => {}, 1000);
        process.stdout.write("ready");
      `,
          ],
          { detached: true, stdio: ["ignore", "pipe", "ignore"] },
        );
        ready = new Promise<void>((resolve, reject) => {
          child!.stdout!.once("data", () => resolve());
          child!.once("error", reject);
        });
        return child;
      }) as typeof spawn;
      try {
        await expect(
          startBridge("codex", options, {
            tempRoot: root,
            credentialPath,
            spawn: spawnFixture,
            fetch: async () => {
              await ready;
              home = join(
                root,
                readdirSync(root).find((name) => name.startsWith("activity-sweep-codex-"))!,
              );
              const copied = join(home, "codex-home", "auth.json");
              expect(readFileSync(copied, "utf8")).toBe(readFileSync(credentialPath, "utf8"));
              expect(statSync(copied).mode & 0o777).toBe(0o600);
              expect(statSync(home).mode & 0o777).toBe(0o700);
              checkedCredentials = true;
              return new Response(null, { status: 503 });
            },
            readinessAttempts: 1,
            pollMs: 0,
            stopBudgetMs: 50,
          }),
        ).rejects.toThrow("codex bridge did not start");
        expect(checkedCredentials).toBe(true);
        expect(home).not.toBe("");
        expect(existsSync(home)).toBe(false);
        expect(readdirSync(root)).toEqual(["fake-auth.json"]);
        expect(child!.signalCode).toBe(ignoreTerm ? "SIGKILL" : "SIGTERM");
        expect(() => process.kill(child!.pid!, 0)).toThrow();
      } finally {
        // Only our fixture's process group, even when an assertion fails.
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          process.kill(-child.pid, "SIGKILL");
          await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
        }
      }
    },
  );

  test("successful startup transfers home ownership to the caller", async () => {
    const { root, credentialPath } = fixture();
    const bridge = await startBridge("codex", options, {
      tempRoot: root,
      credentialPath,
      spawn: (() =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore",
        })) as typeof spawn,
      fetch: async () => new Response(null, { status: 200 }),
    });
    try {
      expect(existsSync(join(bridge.home, "codex-home", "auth.json"))).toBe(true);
    } finally {
      await stopBridge(bridge);
      rmSync(bridge.home, { recursive: true, force: true });
    }
    expect(() => process.kill(bridge.child.pid!, 0)).toThrow();
  });
});
