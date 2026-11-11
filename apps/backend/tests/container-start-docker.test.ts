/** Real Docker endpoints and published ports, with bounded collision fault injection. */
import { afterAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import {
  backendHostPortLabelArguments,
  chooseBackendHostPorts,
} from "../src/core/container-host-ports";
import {
  PORT_COLLISION_RETRIES,
  PORT_HOLD_RETRY_DELAYS_MS,
  startDockerContainer,
} from "../src/core/container-start";
import { createServer, type Server } from "node:net";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { runCommand } from "../src/core/shell";

const image = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim();
const enabled = process.env.RUN_LIVE_DOCKER_TESTS === "1" && Boolean(image);
const live = enabled ? test : test.skip;
const runId = `start-${crypto.randomUUID()}`;
const containers: string[] = [];
let network: string | undefined;
async function docker(args: string[]) {
  return (await runCommand("docker", args, { timeoutMs: 60_000 })).stdout.trim();
}
afterAll(async () => {
  for (const id of containers) await docker(["rm", "-f", id]);
  if (network) await docker(["network", "rm", network]);
}, 180_000);

async function fixture(hostPort = "", extra: string[] = []) {
  if (!network) {
    network = await docker([
      "network",
      "create",
      "--label",
      `orkestrator-qualification=${runId}`,
      runId,
    ]);
  }
  const id = await docker([
    "create",
    "--label",
    `orkestrator-qualification=${runId}`,
    "--network",
    network,
    ...(extra.length > 0 ? extra : ["-p", `127.0.0.1:${hostPort}:8080`]),
    "--entrypoint",
    "bun",
    image!,
    "-e",
    'Bun.serve({port:8080,fetch:()=>new Response("ready")});',
  ]);
  containers.push(id);
  return id;
}
/** Listens on 127.0.0.1:`port`; null when another socket already holds it. */
function hold(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
function release(server: Server | null): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}
async function rootless(): Promise<boolean> {
  return (await docker(["info", "-f", "{{json .SecurityOptions}}"])).includes("name=rootless");
}

async function assertPublished(id: string) {
  const attached = JSON.parse(
    await docker(["inspect", "-f", "{{json .NetworkSettings.Networks}}", id]),
  );
  expect(Object.keys(attached)).toHaveLength(1);
  const mapping = await docker(["port", id, "8080/tcp"]);
  expect(mapping).toMatch(/^127\.0\.0\.1:\d+$/);
  let reply = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    reply = await fetch(`http://${mapping}`)
      .then((response) => response.text())
      .catch(() => "");
    if (reply === "ready") break;
    await Bun.sleep(50);
  }
  expect(reply).toBe("ready");
}

describe("Docker start recovery", () => {
  // Use TMPDIR on nosuid/nodev to exercise the daemon's actual mount behavior.
  // Some kernel/runtime combinations preserve those flags and allow the mount.
  test.skipIf(!enabled || process.env.RUN_ROOTLESS_MOUNT_TESTS !== "1")(
    "a rootless file bind stays read-only or reports a typed topology refusal",
    async () => {
      const security = JSON.parse(await docker(["info", "-f", "{{json .SecurityOptions}}"]));
      expect(security).toContain("name=rootless");
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-remount-"));
      const source = path.join(root, "input");
      try {
        await fs.writeFile(source, "fixture", { mode: 0o600 });
        const id = await docker([
          "create",
          "--label",
          `orkestrator-qualification=${runId}`,
          "--mount",
          `type=bind,src=${source},dst=/etc/orkestrator-seed/input,readonly`,
          "--entrypoint",
          "sleep",
          image!,
          "600",
        ]);
        containers.push(id);
        const error = await startDockerContainer(id).then(
          () => null,
          (error: unknown) => error,
        );
        if (error) {
          expect(parseContainerLifecycleError(error)).toMatchObject({
            code: "unsupported-topology",
          });
          expect((error as Error).message).toContain(`${source} at /etc/orkestrator-seed/input`);
          expect(await docker(["inspect", "-f", "{{.State.Running}}", id])).toBe("false");
        } else {
          expect(
            await docker([
              "exec",
              "--user",
              "root",
              id,
              "sh",
              "-c",
              'test "$(cat /etc/orkestrator-seed/input)" = fixture && if printf changed > /etc/orkestrator-seed/input; then exit 1; else echo readonly; fi',
            ]),
          ).toBe("readonly");
          expect(await fs.readFile(source, "utf8")).toBe("fixture");
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  live(
    "a real fixed-port collision recovers when its listener closes",
    async () => {
      const blocker = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("busy"),
      });
      try {
        const id = await fixture(String(blocker.port));
        await expect(startDockerContainer(id)).rejects.toThrow(
          /address already in use|port is already allocated/i,
        );
        blocker.stop(true);
        await startDockerContainer(id);
        await assertPublished(id);
      } finally {
        blocker.stop(true);
      }
    },
    120_000,
  );

  for (const verb of ["start", "restart"] as const) {
    live(
      `detached collision failures past the retries during ${verb} preserve a later start's ports`,
      async () => {
        const id = await fixture();
        if (verb === "restart") await startDockerContainer(id);
        let failures = 0;
        const verbs: string[] = [];
        // Rootful Docker shares the host allocator and cannot naturally reproduce
        // RootlessKit's automatic-port race. Detach real Docker endpoints at the
        // process boundary exactly as the recorded rootless failure does.
        const run: typeof runCommand = async (command, args = [], options) => {
          if (
            (args[0] === "start" || args[0] === "restart") &&
            failures <= PORT_COLLISION_RETRIES
          ) {
            verbs.push(args[0]);
            failures++;
            if (verb === "restart" && failures === 1) await docker(["stop", "-t", "1", id]);
            await docker(["network", "disconnect", network!, id]);
            throw new Error("listen tcp4 127.0.0.1:38917: bind: address already in use");
          }
          return runCommand(command, args, options);
        };
        await expect(startDockerContainer(id, { verb, run })).rejects.toThrow(
          "address already in use",
        );
        expect(verbs).toEqual([
          verb,
          ...Array.from({ length: PORT_COLLISION_RETRIES }, () => "start"),
        ]);
        await startDockerContainer(id);
        await assertPublished(id);
      },
      120_000,
    );
  }
});

describe("rootless backend-chosen host ports (to-do 7549 task 4)", () => {
  live(
    "the backend's ports start where Docker's next automatic ports are held",
    async () => {
      if (!(await rootless())) {
        console.warn("skipped: the daemon is not rootless");
        return;
      }
      // Where the daemon's automatic-port cursor stands now.
      const probe = await fixture();
      await startDockerContainer(probe);
      const drawn = Number((await docker(["port", probe, "8080/tcp"])).split(":").at(-1));
      await docker(["stop", "-t", "1", probe]);
      // Hold a run of the ports it draws next, longer than the retries. A
      // port another socket already holds is held all the same.
      const run = PORT_COLLISION_RETRIES + 4;
      const holders = await Promise.all(
        Array.from({ length: run }, (_, index) => hold(drawn + 1 + index)),
      );
      try {
        // Docker's own allocation walks the held run one port per start.
        const automatic = await fixture();
        await expect(startDockerContainer(automatic)).rejects.toThrow(
          /address already in use|port is already allocated/i,
        );
        // The backend's choice is a port the host kernel reports free.
        const chosen = await chooseBackendHostPorts(["-p", "127.0.0.1::8080/tcp"]);
        const id = await fixture("", [
          ...chosen.publishArguments,
          ...backendHostPortLabelArguments(chosen.chosen),
        ]);
        const logs = captureLogs();
        await startDockerContainer(id).finally(() => logs.restore());
        expect(logs.records().filter((r) => r.event === "start.port-collision-retrying")).toEqual(
          [],
        );
        expect(await docker(["port", id, "8080/tcp"])).toBe(`127.0.0.1:${chosen.chosen[0]}`);
        await assertPublished(id);
        // A later start that finds its backend-chosen port held retries that
        // port after a pause, and starts once the holder has gone.
        await docker(["stop", "-t", "1", id]);
        const blocker = await hold(chosen.chosen[0]!);
        expect(blocker).not.toBeNull();
        const pauses: number[] = [];
        await startDockerContainer(id, {
          sleep: async (ms) => {
            pauses.push(ms);
            await release(blocker);
          },
        });
        expect(pauses).toEqual([PORT_HOLD_RETRY_DELAYS_MS[0]!]);
        expect(await docker(["port", id, "8080/tcp"])).toBe(`127.0.0.1:${chosen.chosen[0]}`);
        await assertPublished(id);
      } finally {
        await Promise.all(holders.map(release));
      }
    },
    180_000,
  );
});
