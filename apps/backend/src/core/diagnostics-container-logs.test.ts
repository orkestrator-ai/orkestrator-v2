import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import { DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS } from "@orkestrator/protocol/backend-diagnostics";
import { buildDiagnosticsBundle, type DiagnosticsSources } from "./diagnostics-bundle.js";
import {
  collectContainerLogs,
  containerLogOptions,
  containerServerLogFiles,
  normaliseContainerLogChoice,
  type ContainerLogReader,
} from "./diagnostics-container-logs.js";
import type { Environment } from "./models.js";

/** Built by concatenation so this file does not itself look like it holds a token. */
const GITHUB_TOKEN = `ghp_${"A1b2C3d4".repeat(4)}abcd`;
const HOME_DIR = "/home/fixture-user";

const RESUME_FALLBACK = JSON.stringify({
  orklog: 1,
  ts: "2026-11-05T10:00:00.000Z",
  level: "warn",
  area: "codex-bridge",
  event: "session.resume-fell-back",
  fields: { reason: "thread-missing" },
});

function environment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-a",
    name: "Alpha",
    status: "running",
    environmentType: "containerized",
    containerId: "container-a",
    ...overrides,
  } as Environment;
}

interface FakeDocker {
  reader: ContainerLogReader;
  execs: Array<{ containerId: string; command: string }>;
}

function fakeDocker(
  environments: Environment[],
  files: Record<string, Record<string, string>>,
  options: { running?: Set<string>; failing?: Set<string> } = {},
): FakeDocker {
  const execs: FakeDocker["execs"] = [];
  return {
    execs,
    reader: {
      getEnvironment: async (id) => environments.find((item) => item.id === id) ?? null,
      isRunning: async (containerId) => options.running?.has(containerId) ?? true,
      exec: async (containerId, command) => {
        execs.push({ containerId, command });
        if (options.failing?.has(containerId)) throw new Error("docker exec failed");
        const inContainer = files[containerId] ?? {};
        if (command.startsWith("for f in")) {
          return Object.keys(inContainer)
            .filter((file) => inContainer[file])
            .map((file) => `${file}\n`)
            .join("");
        }
        const file = Object.keys(inContainer).find((name) => command.includes(` ${name} `));
        return file ? inContainer[file]! : "";
      },
    },
  };
}

async function untar(archive: Buffer): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const reader = extract();
  const done = new Promise<void>((resolve, reject) => {
    reader.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => chunks.push(chunk as Buffer));
      stream.on("end", () => {
        files.set(header.name, Buffer.concat(chunks).toString("utf8"));
        next();
      });
    });
    reader.on("finish", resolve);
    reader.on("error", reject);
  });
  reader.end(gunzipSync(archive));
  await done;
  return files;
}

async function bundleWith(texts: DiagnosticsSources["texts"], absent = [] as never[]) {
  const logsDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-diagnostics-container-"));
  try {
    return await buildDiagnosticsBundle({
      now: () => new Date("2026-11-05T12:00:00.000Z"),
      appVersion: "2.30.0",
      platform: "linux",
      arch: "x64",
      bunVersion: "1.4.4",
      redaction: {
        dataDir: `${HOME_DIR}/.config/orkestrator`,
        homeDir: HOME_DIR,
        userName: "fixture-user",
        hostName: "fixture-host",
      },
      logsDir,
      debugLogging: false,
      json: [],
      texts,
      notCollected: absent,
    });
  } finally {
    await fs.rm(logsDir, { recursive: true, force: true });
  }
}

describe("choosing container logs", () => {
  test("a choice is unique and sorted, and bounded", () => {
    expect(normaliseContainerLogChoice(undefined)).toEqual([]);
    expect(normaliseContainerLogChoice(["b", "a", "b"])).toEqual(["a", "b"]);
    const tooMany = Array.from(
      { length: DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS + 1 },
      (_, index) => `env-${index}`,
    );
    expect(() => normaliseContainerLogChoice(tooMany)).toThrow(
      `Choose at most ${DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS}`,
    );
    expect(() => normaliseContainerLogChoice([""])).toThrow("environment ids");
  });

  test("the dialog is offered container environments only, by name, marking the chosen", () => {
    const options = containerLogOptions(
      [
        environment({ id: "env-b", name: "Beta", status: "stopped", containerId: "c-b" }),
        environment({ id: "env-a", name: "Alpha" }),
        environment({ id: "env-local", name: "Local", environmentType: "local" }),
        environment({ id: "env-new", name: "No container yet", containerId: undefined }),
      ],
      ["env-b"],
    );
    expect(options).toEqual([
      { environmentId: "env-a", name: "Alpha", status: "running", included: false },
      { environmentId: "env-b", name: "Beta", status: "stopped", included: true },
    ]);
  });
});

describe("reading the chosen environments' server logs", () => {
  test("nothing is read when nothing is chosen", async () => {
    const docker = fakeDocker([environment({})], {});
    expect(await collectContainerLogs([], docker.reader)).toEqual({ texts: [], absent: [] });
    expect(docker.execs).toEqual([]);
  });

  test("one exec lists the servers that wrote a log, then one exec reads each", async () => {
    const docker = fakeDocker([environment({})], {
      "container-a": {
        "/tmp/codex-bridge.log": `${RESUME_FALLBACK}\nstarted\n`,
        "/tmp/codex-bridge.prev.log": "the run before\n",
        "/tmp/claude-bridge.log": "",
      },
    });
    const { texts, absent } = await collectContainerLogs(["env-a"], docker.reader);
    expect(absent).toEqual([]);
    expect(texts.map((text) => text.path)).toEqual([
      "logs/containers/env-a/codex-bridge.log",
      "logs/containers/env-a/codex-bridge.prev.log",
    ]);
    expect(texts[1]!.description).toContain("before its last relaunch");
    // The list, then one read per log that has content.
    expect(docker.execs).toHaveLength(3);
    expect(docker.execs[0]!.command).toContain("/tmp/pi-bridge.log");
    // Bounded at the source like every container tail.
    expect(docker.execs[1]!.command).toMatch(/^tail -c \d+ \/tmp\/codex-bridge\.log /);
  });

  test("every server's current and previous log is a candidate", () => {
    const files = containerServerLogFiles().map((server) => server.file);
    expect(files).toContain("/tmp/opencode-serve.log");
    expect(files).toContain("/tmp/grok-acp-bridge.prev.log");
    expect(files).toHaveLength(12);
  });

  test("what could not be read is named as absent with its reason", async () => {
    const docker = fakeDocker(
      [
        environment({ id: "env-stopped", containerId: "c-stopped" }),
        environment({ id: "env-local", environmentType: "local", containerId: undefined }),
        environment({ id: "env-broken", containerId: "c-broken" }),
        environment({ id: "env-quiet", containerId: "c-quiet" }),
      ],
      {},
      { running: new Set(["c-broken", "c-quiet"]), failing: new Set(["c-broken"]) },
    );
    const { texts, absent } = await collectContainerLogs(
      ["env-stopped", "env-local", "env-gone", "env-broken", "env-quiet", "../escape"],
      docker.reader,
    );
    expect(texts).toEqual([]);
    const reasons = Object.fromEntries(absent.map((item) => [item.name, item.reason]));
    expect(reasons["logs/containers/env-stopped"]).toContain("not running");
    expect(reasons["logs/containers/env-local"]).toContain("has no container");
    expect(reasons["logs/containers/env-gone"]).toContain("no environment has this id");
    expect(reasons["logs/containers/env-broken"]).toContain("Docker did not answer");
    expect(reasons["logs/containers/env-quiet"]).toContain("no server has written a log");
    // An id that cannot name a directory is not used as one.
    expect(reasons["logs/containers/environment-6"]).toContain("no environment has this id");
    // A container that is not running is never exec'd into.
    expect(docker.execs.some((exec) => exec.containerId === "c-stopped")).toBe(false);
  });
});

describe("container logs in the written bundle", () => {
  test("they are redacted by the bundle's own pass and listed exactly as written", async () => {
    const raw = [
      RESUME_FALLBACK,
      `push with ${GITHUB_TOKEN} failed`,
      `Authorization: Bearer abcDEF123.${"zZ9".repeat(10)}`,
      `reading ${HOME_DIR}/project/.env`,
      "line-that-explains-the-bug",
    ].join("\n");
    const docker = fakeDocker([environment({})], {
      "container-a": { "/tmp/codex-bridge.log": raw },
    });
    const collected = await collectContainerLogs(["env-a"], docker.reader);
    const { archive, manifest } = await bundleWith(collected.texts);
    const files = await untar(archive);
    const log = files.get("logs/containers/env-a/codex-bridge.log")!;

    expect(log).toContain("line-that-explains-the-bug");
    // The container bridge's essential event reaches the evidence this way (6143 task 2).
    expect(log).toContain("session.resume-fell-back");
    for (const leaked of [GITHUB_TOKEN, "ghp_", "zZ9zZ9", HOME_DIR, "fixture-user"]) {
      expect(`${leaked}: ${log.includes(leaked)}`).toBe(`${leaked}: false`);
    }
    const entry = manifest.entries.find((item) => item.path.startsWith("logs/containers/"))!;
    expect(entry.bytes).toBe(Buffer.byteLength(log));
    expect(entry.redactions).toBeGreaterThan(0);
    expect(entry.description).toContain("riskiest content");
  });
});
