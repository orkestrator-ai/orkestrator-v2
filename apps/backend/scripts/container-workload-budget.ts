import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ContainerResourceLimits } from "@orkestrator/protocol/container-resources";
import { resourceArguments, sharedMemoryMiB } from "../src/core/container-resources.js";

/**
 * Realistic workloads with and without a resource budget, on whatever Docker
 * this machine talks to (`DOCKER_HOST` included, so a remote Linux Engine can
 * be measured from here):
 *
 *   mise exec -- bun apps/backend/scripts/container-workload-budget.ts \
 *     --image orkestrator-v2:dev-<hash> \
 *     [--workloads browser,build,provider,combined] [--repeat 1] \
 *     [--budget budget=2,4096,1024] [--budget other=null,6144,4096] \
 *     [--no-unrestricted] [--source <git checkout>] [--out <file.json>]
 *
 * Each run gets a fresh container from the image (entrypoint bypassed, so no
 * firewall or workspace clone; the default bridge network, so `bun install`
 * can download), created with the condition's `--cpus`, `--memory`,
 * `--memory-swap`, `--pids-limit` and the `--shm-size` the backend would pass
 * (`resourceArguments`, `sharedMemoryMiB`). The workloads live in
 * `scripts/container-workload/`:
 *
 * - browser: Playwright Chromium, 3 browsers × 2 pages, heavy pages, tall
 *   screenshots (shared-memory pressure); browser-single: one browser (one
 *   Playwright worker) with the same 2 pages.
 * - build: this repository's HEAD: cold and warm `bun install`, a Turbo
 *   typecheck of every workspace and a Vite build of apps/web.
 * - provider: 3 concurrent Claude Code CLIs, 3 turns each, with real Bash and
 *   Read tool calls, against a loopback mock of the Messages API (no
 *   credentials; model responses are synthetic).
 * - combined: build, 1 browser (2 pages) and 2 agents at once.
 *
 * Inside each container a fork-free sampler records peak anon, shmem, file
 * and PIDs every 250 ms; the kernel's own `memory.peak`, `pids.peak`,
 * `memory.events` and `cpu.stat` are read at the end. Timings are measured
 * inside the container. The report holds sizes, counts and durations only:
 * no paths, commands, file contents or prompts. Containers are labelled
 * `app=orkestrator-workload-budget` and removed; nothing else is touched.
 */

const LABEL = "app=orkestrator-workload-budget";
const WORKLOAD_DIR = path.join(import.meta.dir, "container-workload");
const WORKLOADS = ["browser", "browser-single", "build", "provider", "combined"] as const;
type Workload = (typeof WORKLOADS)[number];
type Condition = { name: string; limits: ContainerResourceLimits };

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function argumentsNamed(name: string): string[] {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : [],
  );
}

/** `name=cpus,memoryMiB,pids`; `null` leaves an axis unrestricted. */
function parseCondition(spec: string): Condition {
  const [name = "", values = ""] = spec.split("=");
  const [cpus, memoryMiB, pids] = values
    .split(",")
    .map((value) => (value === "null" || value === "" ? null : Number(value)));
  if (!name) throw new Error(`Invalid --budget ${spec}`);
  return { name, limits: { cpus: cpus ?? null, memoryMiB: memoryMiB ?? null, pids: pids ?? null } };
}

async function docker(
  args: string[],
  options: { stdin?: ReadableStream | Blob; allowFailure?: boolean } = {},
): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 && !options.allowFailure) {
    throw new Error(
      `docker ${args.slice(0, 2).join(" ")} failed (${code}): ${stderr.trim().slice(0, 400)}`,
    );
  }
  return stdout.trim();
}

function lastJson(text: string): Record<string, unknown> | null {
  const line = text.split("\n").filter(Boolean).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function copyWorkloads(container: string): Promise<void> {
  const tar = Bun.spawn(["tar", "-C", WORKLOAD_DIR, "-cf", "-", "."], { stdout: "pipe" });
  await docker(
    ["exec", "-i", "-u", "node", container, "sh", "-c", "mkdir -p /tmp/w && tar -xf - -C /tmp/w"],
    {
      stdin: tar.stdout,
    },
  );
}

async function copySource(container: string, source: string): Promise<void> {
  const archive = Bun.spawn(["git", "-C", source, "archive", "--format=tar", "HEAD"], {
    stdout: "pipe",
  });
  await docker(
    [
      "exec",
      "-i",
      "-u",
      "node",
      container,
      "sh",
      "-c",
      "mkdir -p /home/node/src && tar -xf - -C /home/node/src",
    ],
    { stdin: archive.stdout },
  );
}

async function runOnce(
  image: string,
  workload: Workload,
  condition: Condition,
  source: string,
): Promise<Record<string, unknown>> {
  const shm = sharedMemoryMiB(condition.limits);
  const container = await docker([
    "run",
    "-d",
    "--label",
    LABEL,
    "--user",
    "node",
    "--shm-size",
    `${shm}m`,
    ...resourceArguments(condition.limits),
    "--entrypoint",
    "/bin/sleep",
    image,
    "infinity",
  ]);
  try {
    await copyWorkloads(container);
    if (workload === "build" || workload === "combined") await copySource(container, source);
    await docker(["exec", "-d", container, "bash", "/tmp/w/sampler.sh"]);
    const started = performance.now();
    const output = await docker(
      [
        "exec",
        "-e",
        "NODE_PATH=/usr/local/share/npm-global/lib/node_modules",
        "-w",
        "/tmp/w",
        container,
        "bash",
        "-c",
        workload === "browser"
          ? "node browser.cjs"
          : workload === "browser-single"
            ? "BROWSERS=1 node browser.cjs"
            : `bash ${workload}.sh`,
      ],
      { allowFailure: true },
    );
    const hostWallMs = Math.round(performance.now() - started);
    await docker(["exec", container, "touch", "/tmp/w/stop"], { allowFailure: true });
    let peaks: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 20 && !peaks; attempt += 1) {
      await Bun.sleep(250);
      peaks = lastJson(
        await docker(["exec", container, "cat", "/tmp/w/peaks.json"], { allowFailure: true }),
      );
    }
    const cgroup = lastJson(
      await docker(["exec", container, "bash", "/tmp/w/cgroup-final.sh"], { allowFailure: true }),
    );
    const state = await docker(
      ["inspect", "-f", "{{.State.Running}}\t{{.State.OOMKilled}}", container],
      {
        allowFailure: true,
      },
    );
    return {
      workload,
      condition: condition.name,
      limits: condition.limits,
      shmMiB: shm,
      hostWallMs,
      result: lastJson(output),
      peaks,
      cgroup,
      containerStillRunning: state.startsWith("true"),
      containerOomKilled: state.endsWith("true"),
    };
  } finally {
    await docker(["rm", "-f", container], { allowFailure: true });
  }
}

async function main(): Promise<void> {
  const image = argument("--image");
  if (!image) throw new Error("--image is required");
  const workloads = (argument("--workloads") ?? WORKLOADS.join(","))
    .split(",")
    .filter((value): value is Workload => (WORKLOADS as readonly string[]).includes(value));
  const repeat = Number(argument("--repeat") ?? 1);
  const source = path.resolve(argument("--source") ?? path.join(import.meta.dir, "../../.."));
  const conditions: Condition[] = [
    ...(process.argv.includes("--no-unrestricted")
      ? []
      : [{ name: "unrestricted", limits: { cpus: null, memoryMiB: null, pids: null } }]),
    ...(argumentsNamed("--budget").length > 0
      ? argumentsNamed("--budget")
      : ["budget=2,4096,1024"]
    ).map(parseCondition),
  ];
  const info = lastJson(await docker(["info", "--format", "{{json .}}"])) ?? {};
  const daemon = {
    serverVersion: info.ServerVersion ?? null,
    operatingSystem: info.OperatingSystem ?? null,
    architecture: info.Architecture ?? null,
    cpus: info.NCPU ?? null,
    memoryBytes: info.MemTotal ?? null,
    cgroupVersion: info.CgroupVersion ?? null,
    rootless: Array.isArray(info.SecurityOptions)
      ? info.SecurityOptions.some((entry) => String(entry).includes("name=rootless"))
      : null,
    remote: Boolean(process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://")),
  };
  const imageId = await docker(["image", "inspect", "-f", "{{.Id}}", image]);
  const runs: Record<string, unknown>[] = [];
  for (let index = 0; index < repeat; index += 1) {
    for (const workload of workloads) {
      for (const condition of conditions) {
        const run = await runOnce(image, workload, condition, source);
        runs.push({ repeat: index, ...run });
        console.log(JSON.stringify(runs.at(-1)));
      }
    }
  }
  const report = {
    at: new Date().toISOString(),
    driverPlatform: `${process.platform}/${process.arch}`,
    driverCpus: os.cpus().length,
    daemon,
    image: imageId,
    runs,
  };
  const out =
    argument("--out") ??
    path.resolve(
      import.meta.dir,
      `../../../output/benchmarks/workload-${Date.now().toString(36)}.json`,
    );
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${out}`);
}

const cleanup = async () => {
  const ids = (await docker(["ps", "-aq", "--filter", `label=${LABEL}`], { allowFailure: true }))
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) await docker(["rm", "-f", ...ids], { allowFailure: true });
};
process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)));
await main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exitCode = 1;
});
