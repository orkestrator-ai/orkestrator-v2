import { describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  closeElectron,
  electronProcessTree,
} from "../../e2e/agent-testing/design-electron-cleanup";
import { startOwnedPreview } from "../../e2e/perf/preview-server";
import { processAlive, stopProcessGroup, withCleanup } from "../../e2e/process-cleanup";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "design-preview-ownership-"));
  const script = path.join(root, "preview.mjs");
  await writeFile(
    script,
    `
    import { createServer } from 'node:http';
    import { readFileSync, writeFileSync } from 'node:fs';
    writeFileSync('pid', String(process.pid));
    if (process.argv[3] === 'exit') process.exit(23);
    if (process.argv[3] === 'hang') process.on('SIGTERM', () => {});
    createServer((req, res) => {
      if (process.argv[3] === 'hang') return;
      if (process.argv[3] === 'wrong') { res.end('other build'); return; }
      try { res.end(readFileSync('.' + req.url)); }
      catch { res.writeHead(404).end(); }
    }).listen(Number(process.argv[2]), '127.0.0.1');
  `,
  );
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return {
    root,
    port,
    options: (mode = "ready", timeoutMs = 5_000) => ({
      command: [process.execPath, script, String(port), mode],
      cwd: root,
      outDir: root,
      port,
      timeoutMs,
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("design qualification process ownership", () => {
  test("rejects an occupied port without stopping or measuring the other preview", async () => {
    const f = await fixture();
    let requests = 0;
    const decoy = createServer((_request, response) => {
      requests++;
      response.end("other build");
    });
    await new Promise<void>((resolve) => decoy.listen(f.port, "127.0.0.1", resolve));
    try {
      await expect(startOwnedPreview(f.options())).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(requests).toBe(0);
      expect(decoy.listening).toBe(true);
      await expect(readFile(path.join(f.root, "pid"))).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => decoy.close(() => resolve()));
      await f.cleanup();
    }
  });

  test("rejects early preview exit and cleans up an already-exited process group", async () => {
    const f = await fixture();
    try {
      await expect(startOwnedPreview(f.options("exit"))).rejects.toThrow(
        "exited before measurement",
      );
      expect(processAlive(Number(await readFile(path.join(f.root, "pid"), "utf8")))).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("rejects spawn errors before readiness", async () => {
    const f = await fixture();
    try {
      await expect(
        startOwnedPreview({ ...f.options(), command: [path.join(f.root, "missing")] }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.cleanup();
    }
  });

  test("a nonresponsive owned server times out and is killed, even when it ignores SIGTERM", async () => {
    const f = await fixture();
    try {
      await expect(startOwnedPreview(f.options("hang", 500))).rejects.toThrow("did not start");
      expect(processAlive(Number(await readFile(path.join(f.root, "pid"), "utf8")))).toBe(false);
    } finally {
      await f.cleanup();
    }
  }, 10_000);

  test("a successful response with another build identity is never ready", async () => {
    const f = await fixture();
    try {
      await expect(startOwnedPreview(f.options("wrong", 500))).rejects.toThrow("did not start");
      expect(processAlive(Number(await readFile(path.join(f.root, "pid"), "utf8")))).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("accepts only the owned build marker and tolerates repeated shutdown", async () => {
    const f = await fixture();
    try {
      const preview = await startOwnedPreview(f.options());
      try {
        expect(preview.url).toBe(`http://127.0.0.1:${f.port}`);
        expect(processAlive(preview.process.pid!)).toBe(true);
        await stopProcessGroup(preview.process);
        await stopProcessGroup(preview.process);
        expect(processAlive(preview.process.pid!)).toBe(false);
      } finally {
        await stopProcessGroup(preview.process);
      }
    } finally {
      await f.cleanup();
    }
  });

  test("an exited group is not signaled even if the kernel signal probe would report it present", async () => {
    const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    const realKill = process.kill;
    const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid > 0) return realKill(pid, signal);
      if (signal === 0) return true;
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    try {
      await stopProcessGroup(child, 100);
      expect(kill.mock.calls.every(([pid]) => pid > 0)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  test("a shutdown rejection fails a successful journey while remaining cleanup runs", async () => {
    const failure = new Error("shutdown verification failed");
    const calls: string[] = [];
    await expect(
      withCleanup(async () => {
        calls.push("journey");
      }, [
        async () => {
          calls.push("close");
          throw failure;
        },
        async () => {
          calls.push("remove profile");
        },
      ]),
    ).rejects.toBe(failure);
    expect(calls).toEqual(["journey", "close", "remove profile"]);
  });

  test("preserves both journey and shutdown failures", async () => {
    const journey = new Error("journey failed");
    const shutdown = new Error("shutdown failed");
    try {
      await withCleanup(async () => {
        throw journey;
      }, [
        async () => {
          throw shutdown;
        },
      ]);
      throw new Error("Expected qualification failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([journey, shutdown]);
    }
  });

  test("surviving owned descendants fail shutdown verification and are terminated before profile removal", async () => {
    const f = await fixture();
    // A real child tree, whose wrapper exits on quit but whose descendant remains.
    const script = path.join(f.root, "tree.mjs");
    await writeFile(
      script,
      `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync('descendant', String(child.pid));
      setInterval(() => {}, 1000);
    `,
    );
    const child = spawn(process.execPath, [script], {
      cwd: f.root,
      detached: true,
      stdio: "ignore",
    });
    try {
      let descendant = 0;
      for (let i = 0; i < 200; i++) {
        try {
          descendant = Number(await readFile(path.join(f.root, "descendant"), "utf8"));
          break;
        } catch {
          await delay(10);
        }
      }
      expect(descendant).toBeGreaterThan(0);
      const owned = electronProcessTree({ process: () => child });
      expect(owned).toContain(descendant);
      const app = {
        evaluate: async () => {
          child.kill("SIGTERM");
        },
        close: async () => {},
      } as unknown as Parameters<typeof closeElectron>[0];
      await expect(closeElectron(app, owned, 100)).rejects.toThrow("Owned processes did not exit");
      expect(owned.some(processAlive)).toBe(false);
      await f.cleanup();
    } finally {
      await stopProcessGroup(child);
      await f.cleanup();
    }
  });
});
