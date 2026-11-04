import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const logModule = path.join(import.meta.dir, "essential-log.ts");
const loggerModule = path.resolve(import.meta.dir, "../logger.ts");

test("two standalone processes serialize size checks and rotation within the directory cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "essential-concurrency-"));
  const script = path.join(root, "writer.ts");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const waitFor = async (name: string) => {
    const deadline = Date.now() + 5_000;
    while (!(await Bun.file(path.join(root, name)).exists())) {
      if (Date.now() >= deadline) throw new Error(`barrier timed out: ${name}`);
      await Bun.sleep(5);
    }
  };
  try {
    await writeFile(
      script,
      `
      import { installEssentialLog } from ${JSON.stringify(logModule)};
      import { configureLogger, createLogger } from ${JSON.stringify(loggerModule)};
      import { existsSync, statSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
      import path from "node:path";
      const [root, id] = process.argv.slice(2);
      const signal = name => path.join(root, name);
      configureLogger({ sink: () => {} });
      let held = false;
      const log = installEssentialLog({ dataDir: root, owner: "backend",
        bounds: { maxFileBytes: 1024, eventBurst: 1000 },
        beforeWrite: async () => { writeFileSync(signal("attempt-" + id), ""); },
        io: {
          statSync: (...args) => {
            if (id === "1" && !held) {
              held = true;
              writeFileSync(signal("locked"), "");
              const deadline = Date.now() + 5000;
              while (!existsSync(signal("release"))) {
                if (Date.now() > deadline) throw new Error("release timed out");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
              }
            }
            return statSync(...args);
          },
          appendFileSync: (...args) => {
            appendFileSync(...args);
            const directory = path.join(root, "logs", "essential");
            const bytes = readdirSync(directory).filter(n => n.endsWith(".jsonl"))
              .reduce((n, file) => n + statSync(path.join(directory, file)).size, 0);
            if (bytes > 4096) throw new Error("cap exceeded");
          },
        },
      });
      for (let code = 0; code < 40; code++) createLogger("backend").info("shutdown.finished", { code });
      await log.flush();
      writeFileSync(signal("flushed-" + id), "");
      while (!existsSync(signal("finish"))) await Bun.sleep(5);
      createLogger("backend").info("shutdown.finished", { code: 100 + Number(id) });
      await log.stop();
    `,
    );
    const launch = (id: string) => {
      const child = Bun.spawn([process.execPath, script, root, id], {
        stdout: "ignore",
        stderr: "pipe",
      });
      children.push(child);
      return child;
    };
    launch("1");
    await waitFor("locked");
    launch("2");
    await waitFor("attempt-2");
    await writeFile(path.join(root, "release"), "");
    await Promise.all([waitFor("flushed-1"), waitFor("flushed-2")]);
    await writeFile(path.join(root, "finish"), "");
    for (const child of children) {
      expect(
        await child.exited,
        await new Response(typeof child.stderr === "number" ? undefined : child.stderr).text(),
      ).toBe(0);
    }
    const directory = path.join(root, "logs", "essential");
    const files = await readdir(directory);
    expect(files.length).toBeLessThanOrEqual(4);
    let bytes = 0;
    let text = "";
    for (const file of files) {
      bytes += (await stat(path.join(directory, file))).size;
      text += await readFile(path.join(directory, file), "utf8");
    }
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(text).toContain('"code":101');
    expect(text).toContain('"code":102');
    expect(text).not.toContain('"event":"entries.dropped"');
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
