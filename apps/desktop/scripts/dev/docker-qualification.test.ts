import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("qualification Docker shim retries exhausted pools only for owned network creates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qualification-docker-"));
  try {
    const real = path.join(root, "docker");
    await writeFile(
      real,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
if (args.includes("--subnet")) { console.log("fixture-network-id"); process.exit(0); }
console.error("all predefined address pools have been fully subnetted"); process.exit(1);
`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(root, "ip"),
      '#!/bin/sh\nprintf \'[{"gateway":"192.0.2.1","dev":"eth0"}]\\n\'\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      ORKESTRATOR_QUALIFICATION_DOCKER: real,
      CALLS: path.join(root, "calls"),
    };
    // Match the isolated backend: only PATH survives its safe-env allowlist.
    delete (env as Partial<typeof env>).ORKESTRATOR_QUALIFICATION_DOCKER;
    env.PATH = `${path.join(import.meta.dir, "docker-qualification-bin")}:${env.PATH}`;
    const run = async (args: string[]) => {
      const child = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "docker-qualification.ts"), ...args],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout };
    };
    expect((await run(["network", "create", "foreign"])).code).toBe(1);
    expect((await readFile(env.CALLS, "utf8")).trim().split("\n")).toHaveLength(1);
    const result = await run(["network", "create", "--label", "orkestrator-owner=test", "owned"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("fixture-network-id");
    const calls = (await readFile(env.CALLS, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[2]).toEqual([
      "network",
      "create",
      "--subnet",
      "172.16.240.0/29",
      "--label",
      "orkestrator-owner=test",
      "owned",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
