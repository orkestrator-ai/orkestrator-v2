import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

const scripts = path.resolve(import.meta.dir, "../scripts");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-workload-"));
  dirs.push(dir);
  return dir;
}

for (const failure of ["launch", "context", "page", "none"]) {
  test(`browser workload records ${failure} failure and closes launched browsers`, async () => {
    const source = await fs.readFile(path.join(scripts, "container-workload/browser.cjs"), "utf8");
    let closed = 0;
    let contextsClosed = 0;
    const page = {
      on() {},
      async goto() {},
      async evaluate() {},
      async screenshot() {},
    };
    const context = {
      async newPage() {
        if (failure === "page") throw new Error("resource pressure");
        return page;
      },
      async close() {
        contextsClosed += 1;
      },
    };
    const chromium = {
      async launch() {
        if (failure === "launch") throw new Error("launch failed");
        return {
          on() {},
          async newContext() {
            if (failure === "context") throw new Error("resource pressure");
            return context;
          },
          async close() {
            closed += 1;
          },
        };
      },
    };
    const output = new Promise<string>((resolve) => {
      runInNewContext(source, {
        require: (name: string) => (name === "playwright" ? { chromium } : { writeFileSync() {} }),
        performance,
        process: { env: { BROWSERS: "2", PAGES: "2", ROUNDS: "1" }, stdout: { write: resolve } },
      });
    });
    const result = JSON.parse(await output);
    expect(result.fatal).toBeUndefined();
    expect(result.launchFailures).toBe(failure === "launch" ? 2 : 0);
    expect(result.setupFailures).toBe(["context", "page"].includes(failure) ? 4 : 0);
    expect(result.roundsCompleted).toBe(failure === "none" ? 4 : 0);
    expect(closed).toBe(failure === "launch" ? 0 : 2);
    expect(contextsClosed).toBe(["page", "none"].includes(failure) ? 4 : 0);
  });
}

test("provider emits one five-field row for tool-free, failed-empty and tool-using turns", async () => {
  const dir = await fixture();
  const source = await fs.readFile(path.join(scripts, "container-workload/provider.sh"), "utf8");
  const agent = source.slice(
    source.indexOf("agent() {"),
    source.indexOf(": > /tmp/w/provider.tsv"),
  );
  const cli = path.join(dir, "cli");
  await fs.writeFile(
    cli,
    `#!/bin/sh
count=$(cat count 2>/dev/null || echo 0)
count=$((count + 1)); echo "$count" > count
case "$count" in
  1) echo '{"type":"result"}' ;;
  2) exit 1 ;;
  3) echo '{"type":"tool_result"}' ;;
esac
`,
    { mode: 0o755 },
  );
  const child = Bun.spawn(
    [
      "bash",
      "-c",
      `
AGENTS=1; TURNS=3
CLAUDE_CLI_PATH="$1"
now() { echo 100; }
timeout() { shift; "$@"; }
${agent.replaceAll("/tmp/w", dir)}
agent 1
`,
      "test",
      cli,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  const rows = (await fs.readFile(path.join(dir, "provider.tsv"), "utf8")).trim().split("\n");
  expect(rows).toEqual(["1 1 0 0 0", "1 2 1 0 0", "1 3 0 0 1"]);
});

// Every fake daemon keeps a label -> ID mapping. Only a matching run filter
// returns IDs, so a broad app-label cleanup would remove the other invocation.
async function fakeDaemon() {
  const dir = await fixture();
  const docker = path.join(dir, "docker");
  await fs.writeFile(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DAEMON_DIR/log"
case "$1" in
  info) echo '{}' ;;
  image) echo image-id ;;
  run)
    while [ "$1" != "--label" ]; do shift; done
    shift 3
    label=$1
    id="container-$$"
    echo "$id" > "$DAEMON_DIR/$label"
    [ "$MODE" = run-failure ] && exit 1
    echo "$id" ;;
  exec)
    case "$*" in
      *'tar -xf'*) cat > /dev/null ;;
      *sampler.sh*) [ "$MODE" = startup-failure ] && exit 1 ;;
      *browser.cjs*) touch "$DAEMON_DIR/ready-$RUN_NAME"; exec sleep 30 ;;
      *provider.sh*) echo '{"workload":"provider","turns":1}' ;;
      *peaks.json*) echo '{"pids":3}' ;;
      *cgroup-final.sh*) echo '{"memoryPeak":100}' ;;
    esac ;;
  inspect) printf 'true\\tfalse\\n' ;;
  ps)
    label=
    for arg in "$@"; do
      case "$arg" in label=*) label=$(printf '%s' "$arg" | cut -c7-) ;; esac
    done
    if [ "$label" = app=orkestrator-workload-budget ]; then
      cat "$DAEMON_DIR"/orkestrator-workload-run=* 2>/dev/null
    elif [ -f "$DAEMON_DIR/$label" ]; then cat "$DAEMON_DIR/$label"; fi ;;
  rm) shift 2; for id in "$@"; do echo "$id" >> "$DAEMON_DIR/removed"; done ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const launch = (name: string, extra: string[] = [], mode = "") =>
    Bun.spawn(
      [
        process.execPath,
        path.join(scripts, "container-workload-budget.ts"),
        "--image",
        "fixture",
        "--workloads",
        "browser,provider",
        "--no-unrestricted",
        "--out",
        path.join(dir, `${name}.json`),
        ...extra,
      ],
      {
        env: {
          ...process.env,
          PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          DAEMON_DIR: dir,
          RUN_NAME: name,
          MODE: mode,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  return { dir, launch };
}

async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Bun.file(file).exists()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Fixture did not become ready: ${file}`);
}

test("workload timeout collects the report and completes later conditions", async () => {
  const { dir, launch } = await fakeDaemon();
  const child = launch("timeout", ["--timeout-ms", "500"]);
  expect(await child.exited).toBe(0);
  const report = await Bun.file(path.join(dir, "timeout.json")).json();
  expect(report.runs).toHaveLength(2);
  expect(report.runs[0]).toMatchObject({
    executionError: "Docker command timed out",
    peaks: { pids: 3 },
  });
  expect(report.runs[1].result).toEqual({ workload: "provider", turns: 1 });
  const removed = (await fs.readFile(path.join(dir, "removed"), "utf8")).trim().split("\n");
  expect(new Set(removed).size).toBe(2);
}, 10_000);

test("cancelling or rejecting another invocation cannot remove a running workload", async () => {
  const { dir, launch } = await fakeDaemon();
  const first = launch("first");
  const second = launch("second");
  try {
    await Promise.all([
      waitForFile(path.join(dir, "ready-first")),
      waitForFile(path.join(dir, "ready-second")),
    ]);
    const files = (await fs.readdir(dir)).filter((name) =>
      name.startsWith("orkestrator-workload-run="),
    );
    expect(files).toHaveLength(2);
    const ids = await Promise.all(
      files.map(async (file) => (await fs.readFile(path.join(dir, file), "utf8")).trim()),
    );
    const invalid = launch("invalid", ["--timeout-ms", "0"]);
    expect(await invalid.exited).toBe(1);
    expect(await Bun.file(path.join(dir, "removed")).exists()).toBe(false);
    second.kill("SIGINT");
    expect(await second.exited).toBe(130);
    const removed = (await fs.readFile(path.join(dir, "removed"), "utf8")).trim().split("\n");
    expect(removed).toHaveLength(1);
    expect(ids).toContain(removed[0]!);
    // The first driver is still waiting on its browser; its container survives.
    expect(first.exitCode).toBeNull();
    first.kill("SIGTERM");
    expect(await first.exited).toBe(143);
    const allRemoved = (await fs.readFile(path.join(dir, "removed"), "utf8")).trim().split("\n");
    expect(allRemoved.sort()).toEqual(ids.sort());
  } finally {
    if (first.exitCode === null) first.kill("SIGINT");
    if (second.exitCode === null) second.kill("SIGINT");
    await Promise.all([first.exited, second.exited]);
  }
}, 15_000);

for (const mode of ["run-failure", "startup-failure"]) {
  test(`${mode} cleans up only containers labelled for that invocation`, async () => {
    const { dir, launch } = await fakeDaemon();
    const child = launch("failure", [], mode);
    expect(await child.exited).toBe(1);
    const label = (await fs.readdir(dir)).find((name) =>
      name.startsWith("orkestrator-workload-run="),
    )!;
    const id = (await fs.readFile(path.join(dir, label), "utf8")).trim();
    const removed = (await fs.readFile(path.join(dir, "removed"), "utf8")).trim().split("\n");
    expect(removed.every((value) => value === id)).toBe(true);
    expect(removed.length).toBeGreaterThan(0);
  });
}
