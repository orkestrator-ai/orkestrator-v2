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

test.each(["overlap", "direct", "vpn", "subnet", "missing-ip", "non-overlap"])(
  "qualification fallback handles %s safely",
  async (scenario) => {
    const root = await mkdtemp(path.join(tmpdir(), "qualification-branches-"));
    try {
      const real = path.join(root, "docker");
      await writeFile(
        real,
        `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
const calls = readFileSync(process.env.CALLS, "utf8").trim().split("\\n").length;
if (!args.includes("--subnet")) {
 console.error("all predefined address pools have been fully subnetted"); process.exit(1);
}
if (process.env.SCENARIO === "overlap" && calls === 2) { console.error("Pool overlaps with other one"); process.exit(1); }
if (process.env.SCENARIO === "non-overlap") { console.error("permission denied"); process.exit(7); }
console.log("created");
`,
        { mode: 0o755 },
      );
      // Even the missing-ip case has a controlled executable so host PATH cannot
      // accidentally supply ip and turn the refusal into an allocation.
      await writeFile(
        path.join(root, "ip"),
        `#!${process.execPath}
const target = process.argv.at(-1);
if (process.env.SCENARIO === "missing-ip") process.exit(127);
let route = { gateway: "192.0.2.1", dev: "eth0" };
if (target === "172.16.240.0") {
 if (process.env.SCENARIO === "direct") route = { dev: "tun0" };
 if (process.env.SCENARIO === "vpn") route = { gateway: "192.0.2.2", dev: "tun0" };
}
console.log(JSON.stringify([route]));
`,
        { mode: 0o755 },
      );
      const args = ["network", "create", "--label", "orkestrator-owner=test", "owned"];
      if (scenario === "subnet") args.push("--subnet", "192.0.2.0/29");
      const child = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "docker-qualification.ts"), ...args],
        {
          env: {
            ...process.env,
            PATH: root,
            ORKESTRATOR_QUALIFICATION_DOCKER: real,
            CALLS: path.join(root, "calls"),
            SCENARIO: scenario,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const calls = (await readFile(path.join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      if (scenario === "missing-ip" || scenario === "subnet") {
        expect(calls).toEqual([args]);
        expect(code).toBe(scenario === "missing-ip" ? 1 : 0);
      } else if (scenario === "non-overlap") {
        expect(code).toBe(7);
        expect(stderr).toContain("permission denied");
        expect(calls).toHaveLength(2);
      } else {
        expect(code).toBe(0);
        expect(stdout.trim()).toBe("created");
        expect(calls.at(-1)).toContain("172.16.240.8/29");
        expect(calls).toHaveLength(scenario === "overlap" ? 3 : 2);
        if (scenario !== "overlap") expect(calls.flat()).not.toContain("172.16.240.0/29");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "qualification Docker shim execs the real CLI, so stopping a follower stops Docker",
  async () => {
    // A follower the backend stops with SIGTERM (`docker logs -f`) used to run
    // as the shim's child and outlive it (to-do 0019 (retired) task 6). The PATH shim must be
    // the Docker process itself.
    const root = await mkdtemp(path.join(tmpdir(), "qualification-exec-"));
    let child: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
    try {
      await writeFile(path.join(root, "docker"), '#!/bin/sh\necho "$$ $*"\nexec sleep 30\n', {
        mode: 0o755,
      });
      const shim = path.join(import.meta.dir, "docker-qualification-bin", "docker");
      // Only PATH, as in the isolated backend's safe environment.
      const env = {
        PATH: [
          path.join(import.meta.dir, "docker-qualification-bin"),
          root,
          path.dirname(process.execPath),
          "/usr/bin",
          "/bin",
        ].join(":"),
      };
      child = Bun.spawn([shim, "logs", "-f", "fixture"], { env, stdout: "pipe" });
      const reader = child.stdout.getReader();
      let line = "";
      while (!line.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        line += new TextDecoder().decode(value);
      }
      expect(line.trim()).toBe(`${child.pid} logs -f fixture`);
      child.kill("SIGTERM");
      expect(await child.exited).not.toBe(0);
      expect(child.signalCode).toBe("SIGTERM");
    } finally {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
