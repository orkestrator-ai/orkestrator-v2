import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseLogRecordLine, type LogRecord } from "@orkestrator/protocol/logger";

/**
 * A real Bun process dying a real death, because what happens after the listener
 * returns is the runtime's behaviour rather than ours. A listener on
 * `uncaughtException` that returns keeps the process alive, so these pin both that
 * premise and that the monitor the backend uses leaves the death exactly as it was.
 */

const protocolRoot = path.resolve(import.meta.dir, "../../../packages/protocol/src");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-uncaught-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

type Run = { code: number | null; stdout: string; stderr: string };

async function run(source: string, args: string[] = []): Promise<Run> {
  const directory = await temporaryDirectory();
  const script = path.join(directory, "fixture.ts");
  await writeFile(script, source);
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}

// Timers that outlive the throw, so a process that survived it says so.
const THROW = `
setTimeout(() => { throw new TypeError("boom /Users/someone/secret"); }, 5);
setTimeout(() => console.log("STILL ALIVE"), 150);
`;

const IMPORTS = `
import { createLogger } from ${JSON.stringify(`${protocolRoot}/logger.ts`)};
import { installEssentialLog } from ${JSON.stringify(`${protocolRoot}/node/essential-log.ts`)};
import { configureLoggerFromEnvironment } from ${JSON.stringify(`${protocolRoot}/node/logger-environment.ts`)};
import { installUncaughtExceptionLog } from ${JSON.stringify(`${protocolRoot}/node/process-failure-log.ts`)};
`;

/** The dump's own heading. Its source excerpt moves with the fixture's line numbers. */
function dumpHeading(stderr: string): string | undefined {
  return stderr.split("\n").find((line) => line.startsWith("TypeError"));
}

function records(text: string): LogRecord[] {
  return text.split("\n").flatMap((line) => {
    const record = parseLogRecordLine(line);
    return record ? [record] : [];
  });
}

describe("what Bun does with an uncaught exception", () => {
  test("with no listener it prints a dump and exits 1", async () => {
    const result = await run(THROW);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("TypeError: boom");
    expect(result.stdout).not.toContain("STILL ALIVE");
  });

  test("a listener that returns keeps the process alive, which is why the backend has none", async () => {
    const result = await run(`
      process.on("uncaughtException", () => {});
      ${THROW}
      setTimeout(() => process.exit(0), 300);
    `);
    expect(result.stdout).toContain("STILL ALIVE");
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("TypeError: boom");
  });

  test("a monitor that throws would change the exit code, which is why the backend's cannot", async () => {
    const result = await run(`
      process.on("uncaughtExceptionMonitor", () => { throw new Error("from the monitor"); });
      ${THROW}
    `);
    expect(result.code).toBe(7);
  });
});

describe("the backend's uncaught exception log", () => {
  test("dies exactly as with no listener: the same dump, exit 1 and nothing after", async () => {
    const baseline = await run(THROW);
    const monitored = await run(`
      ${IMPORTS}
      installUncaughtExceptionLog();
      createLogger("backend");
      ${THROW}
    `);
    expect(monitored.code).toBe(baseline.code);
    expect(monitored.stdout).not.toContain("STILL ALIVE");
    expect(dumpHeading(monitored.stderr)).toBe(dumpHeading(baseline.stderr));
    expect(dumpHeading(monitored.stderr)).toContain("TypeError: boom");
  });

  test("standalone: one entry reaches the file before the process is gone", async () => {
    const dataDir = await temporaryDirectory();
    const result = await run(
      `
      ${IMPORTS}
      installEssentialLog({ dataDir: process.argv[2], owner: "backend" });
      installUncaughtExceptionLog();
      ${THROW}
    `,
      [dataDir],
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("TypeError: boom");

    const file = path.join(dataDir, "logs", "essential", "essential.jsonl");
    const written = records(await readFile(file, "utf8"));
    const crash = written.filter((record) => record.event === "uncaught-exception");
    expect(crash).toHaveLength(1);
    expect(crash[0]).toMatchObject({
      level: "error",
      area: "process",
      fields: { origin: "uncaughtException", "error.name": "TypeError" },
    });
    expect(await readFile(file, "utf8")).not.toContain("secret");
  });

  test("standalone: entries still queued when it dies are not lost with it", async () => {
    const dataDir = await temporaryDirectory();
    await run(
      `
      ${IMPORTS}
      installEssentialLog({ dataDir: process.argv[2], owner: "backend" });
      installUncaughtExceptionLog();
      const log = createLogger("backend");
      setTimeout(() => {
        for (let code = 0; code < 8; code += 1) log.info("shutdown.finished", { code });
        throw new TypeError("boom");
      }, 5);
    `,
      [dataDir],
    );
    const written = records(
      await readFile(path.join(dataDir, "logs", "essential", "essential.jsonl"), "utf8"),
    );
    expect(written.filter((record) => record.event === "shutdown.finished").length).toBe(8);
    expect(written.at(-1)?.event).toBe("uncaught-exception");
  });

  test("supervised: the entry crosses stdio as a record for the desktop to keep", async () => {
    const result = await run(`
      ${IMPORTS}
      import { installBoundedConsole } from ${JSON.stringify(path.resolve(import.meta.dir, "bounded-console.ts"))};
      installBoundedConsole();
      configureLoggerFromEnvironment(process.env, { relayToSupervisor: true });
      installUncaughtExceptionLog();
      ${THROW}
    `);
    expect(result.code).toBe(1);
    const crash = records(`${result.stdout}\n${result.stderr}`).filter(
      (record) => record.event === "uncaught-exception",
    );
    expect(crash).toHaveLength(1);
    expect(crash[0]?.level).toBe("error");
    expect(result.stderr).toContain("TypeError: boom");
  });

  test("a rejected top-level await is reported too, and still ends the process", async () => {
    const dataDir = await temporaryDirectory();
    const result = await run(
      `
      ${IMPORTS}
      process.on("unhandledRejection", () => {});
      installEssentialLog({ dataDir: process.argv[2], owner: "backend" });
      installUncaughtExceptionLog();
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new TypeError("boom");
    `,
      [dataDir],
    );
    expect(result.code).toBe(1);
    const written = records(
      await readFile(path.join(dataDir, "logs", "essential", "essential.jsonl"), "utf8"),
    );
    expect(written.at(-1)).toMatchObject({
      event: "uncaught-exception",
      fields: { origin: "unhandledRejection" },
    });
  });

  test("an ordinary rejection goes to the guard and is not reported as a crash", async () => {
    const dataDir = await temporaryDirectory();
    const result = await run(
      `
      ${IMPORTS}
      import { installFatalRejectionGuard } from ${JSON.stringify(`${protocolRoot}/fatal-rejections.ts`)};
      import { logUnhandledRejection } from ${JSON.stringify(`${protocolRoot}/node/process-failure-log.ts`)};
      installEssentialLog({ dataDir: process.argv[2], owner: "backend" });
      installFatalRejectionGuard({ label: "[Backend]", onRejection: logUnhandledRejection });
      installUncaughtExceptionLog();
      await new Promise((resolve) => setTimeout(resolve, 5));
      Promise.reject(new RangeError("stray /Users/someone/secret"));
      setTimeout(() => process.exit(0), 100);
    `,
      [dataDir],
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Unhandled promise rejection (continuing)");
    const text = await readFile(path.join(dataDir, "logs", "essential", "essential.jsonl"), "utf8");
    const written = records(text);
    expect(written.map((record) => record.event)).toContain("rejection.unhandled");
    expect(written.map((record) => record.event)).not.toContain("uncaught-exception");
    expect(text).not.toContain("secret");
  });
});

test("real standalone startup retains a toolchain lease failure before backend initialization", async () => {
  const dataDir = await temporaryDirectory();
  const toolchains = path.join(dataDir, "toolchains");
  const bin = path.join(toolchains, "bin", "fixture");
  const target = path.join(toolchains, "codex", "fixture", "bin", "codex");
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(target, "fixture");
  await symlink(target, path.join(bin, "codex"));
  // Force acquireVersionLease's mkdir to fail while logs/ remains writable.
  await writeFile(path.join(toolchains, ".leases"), "block lease creation");
  const result = await run(`
    delete process.env.ORKESTRATOR_DESKTOP_SUPERVISED;
    process.argv = [process.execPath, ${JSON.stringify(path.join(import.meta.dir, "main.ts"))},
      "--data-dir", ${JSON.stringify(dataDir)}, "--toolchain-bin-dir", ${JSON.stringify(bin)},
      "--runtime-flavor", "production", "--port", "0", "--control-port", "0"];
    await import(${JSON.stringify(path.join(import.meta.dir, "main.ts"))});
  `);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("ENOTDIR");
  const text = await readFile(path.join(dataDir, "logs", "essential", "essential.jsonl"), "utf8");
  const crash = records(text).filter((record) => record.event === "uncaught-exception");
  expect(crash).toHaveLength(1);
  expect(crash[0]?.fields?.["error.code"]).toBe("ENOTDIR");
  expect(text).not.toContain(dataDir);
  expect(text).not.toContain("block lease creation");
});
