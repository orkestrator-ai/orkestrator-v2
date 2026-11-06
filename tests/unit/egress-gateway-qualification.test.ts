import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, writeStub } from "./firewall-test-support";

const request = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
      response.on("error", reject);
    }).on("error", reject);
  });

const script = join(root, "scripts/qualify-egress-gateway.sh");

/** Bounds listener startup independently of resolver availability. */
const LISTENER_START_TIMEOUT_MS = 20_000;
/** Startup plus local requests and owned-child cleanup. */
const LISTENER_TEST_TIMEOUT_MS = 30_000;

const startProbeServer = (dir: string, env: Record<string, string | undefined> = process.env) =>
  Bun.spawn({
    cmd: [
      "python3",
      join(root, "scripts/egress-probe-server.py"),
      "--bind",
      "127.0.0.1",
      "--ports-file",
      join(dir, "ports"),
    ],
    cwd: dir,
    env,
    stdout: "ignore",
    stderr: "pipe",
  });

/** The two published ports, or a failure naming whether the listener died. */
async function publishedPorts(dir: string, child: ReturnType<typeof startProbeServer>) {
  // Both sockets listen before the atomic ports-file publication.
  // Preserve main's startup allowance for a loaded host (flake 5961).
  const deadline = performance.now() + LISTENER_START_TIMEOUT_MS;
  while (performance.now() < deadline) {
    try {
      return readFileSync(join(dir, "ports"), "utf8").trim().split(" ");
    } catch {
      if (child.exitCode !== null) break;
      await Bun.sleep(20);
    }
  }
  const state = child.exitCode === null ? "still running" : `exited ${child.exitCode}`;
  child.kill();
  await child.exited;
  const stderr = (await new Response(child.stderr).text()).slice(-2000);
  throw new Error(`probe listener published no ports (${state}): ${stderr}`);
}

test(
  "probe listeners serve only the fixed response, even from a directory containing files",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ork-egress-listener-"));
    writeFileSync(join(dir, "sentinel"), "private sentinel");
    const child = startProbeServer(dir);
    try {
      const ports = await publishedPorts(dir, child);
      expect(ports).toHaveLength(2);
      expect(ports[0]).not.toBe(ports[1]);
      for (const port of ports) {
        const url = `http://127.0.0.1:${port}`;
        expect((await request(`${url}/probe`)).body).toBe("egress-probe\n");
        for (const path of ["/", "/sentinel", "/../sentinel", "/%2e%2e/sentinel"]) {
          const response = await request(`${url}${path}`);
          expect(response.status).toBe(404);
          expect(response.body).not.toContain("private sentinel");
        }
      }
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  LISTENER_TEST_TIMEOUT_MS,
);

// HTTPServer.server_bind names the server with a reverse-DNS query; a slow
// resolver held both listeners (and the qualification script waiting on them)
// past their deadlines. A resolver that refuses outright must not matter.
test(
  "probe listeners publish their ports without consulting the resolver",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ork-egress-resolver-"));
    const site = join(dir, "site");
    mkdirSync(site);
    writeFileSync(
      join(site, "sitecustomize.py"),
      "import socket\n" +
        "def refuse(*_args, **_kwargs):\n" +
        "    raise OSError('resolver consulted')\n" +
        "socket.getfqdn = refuse\n" +
        "socket.gethostbyaddr = refuse\n",
    );
    const child = startProbeServer(dir, { ...process.env, PYTHONPATH: site });
    try {
      const ports = await publishedPorts(dir, child);
      expect(ports).toHaveLength(2);
      for (const port of ports) {
        expect((await request(`http://127.0.0.1:${port}/probe`)).body).toBe("egress-probe\n");
      }
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  LISTENER_TEST_TIMEOUT_MS,
);

test("same-timestamp invocations have unique names and never clean up failed creations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ork-egress-ownership-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeStub(bin, "date", "echo 42");
  writeStub(
    bin,
    "docker",
    `printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  'network create') exit 1 ;;
  *) exit 0 ;;
esac`,
  );
  try {
    const runs = await Promise.all(
      [0, 1].map(async (index) => {
        const log = join(dir, `calls-${index}`);
        const child = Bun.spawn({
          cmd: ["bash", script, "unused-image"],
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await child.exited).toBe(2);
        return readFileSync(log, "utf8");
      }),
    );
    expect(runs[0]).not.toBe(runs[1]);
    for (const calls of runs) {
      expect(calls).toMatch(
        /^network create --label orkestrator-owner=egress-gateway-egp[0-9a-f]{24} egp[0-9a-f]{24}-net\n$/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const failure of ["create", "start"]) {
  test(`cleanup after failed container ${failure} removes only successfully created resources`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ork-egress-cleanup-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeStub(
      bin,
      "docker",
      `printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  info) echo 'Docker Desktop' ;;
  ${failure}) exit 1 ;;
esac`,
    );
    try {
      const log = join(dir, "calls");
      const child = Bun.spawn({
        cmd: ["bash", script, "unused-image"],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(2);
      const calls = readFileSync(log, "utf8").split("\n");
      const network = calls[0]!.split(" ").at(-1)!;
      const boot = `${network.slice(0, -4)}-default-absent`;
      expect(calls).toContain(`network rm ${network}`);
      expect(calls.filter((line) => line.startsWith("rm -f egp"))).toEqual(
        failure === "start" ? [`rm -f ${boot}`] : [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
