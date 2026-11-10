import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import {
  DIAGNOSTICS_CHUNK_BYTES,
  DIAGNOSTICS_REDACTION_NOTICE,
  type DiagnosticsManifest,
} from "@orkestrator/protocol/backend-diagnostics";
import {
  DIAGNOSTICS_DEBUG_LOG_BYTES,
  DiagnosticsBundles,
  DiagnosticsPlanError,
  buildDiagnosticsBundle,
  type DiagnosticsSources,
} from "./diagnostics-bundle.js";

/**
 * Fixture tokens only, built by concatenation so this file does not itself look
 * like it holds any. No test here reads the host's credentials, logs or databases:
 * every path is a temporary directory and the home directory is a fixture.
 */
const TOKENS = {
  githubClassic: `ghp_${"A1b2C3d4".repeat(4)}abcd`,
  githubOauth: `gho_${"Z9y8X7w6".repeat(4)}efgh`,
  githubFineGrained: `github_pat_${"11ABCDEFG0".repeat(3)}_${"x1Y2z3".repeat(8)}`,
  anthropic: `sk-ant-api03-${"Qw3rTy12".repeat(8)}-${"AbCd".repeat(4)}AA`,
  openaiProject: `sk-proj-${"M4nB5vC6".repeat(8)}`,
  openaiLegacy: `sk-${"T1u2V3w4".repeat(6)}`,
  bearer: `abcDEF123.${"zZ9".repeat(10)}`,
};
const HOME_DIR = "/home/fixture-user";
const OTHER_HOMES = [
  "/home/somebody-else/src",
  "/Users/macperson/Library",
  "C:\\Users\\winperson\\AppData",
];
const TAIL_MARKER = "line-that-explains-the-bug";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-diagnostics-bundle-"));
  directories.push(directory);
  return directory;
}

/** Every form a credential has turned up in, in each format the ticket names. */
function hostileLines(): string[] {
  return [
    `${new Date(0).toISOString()} [git] push with token ${TOKENS.githubClassic} failed`,
    `remote: https://x-access-token:${TOKENS.githubOauth}@github.com/org/repo.git`,
    `MY_${TOKENS.githubClassic}`,
    `GITHUB_TOKEN=${TOKENS.githubFineGrained}`,
    `ANTHROPIC_API_KEY=${TOKENS.anthropic}`,
    `{"headers":{"x-api-key":"${TOKENS.anthropic}"}}`,
    `OPENAI_API_KEY="${TOKENS.openaiProject}"`,
    `client created with ${TOKENS.openaiLegacy}`,
    `Authorization: Bearer ${TOKENS.bearer}`,
    `{"authorization":"bearer ${TOKENS.bearer}"}`,
    // A JSON record whose string holds an escaped credential.
    JSON.stringify({
      orklog: 1,
      ts: "2026-11-05T10:00:00.000Z",
      level: "info",
      area: "backend",
      event: "starting",
      fields: { detail: `{"token":"${TOKENS.githubClassic}"} at ${HOME_DIR}/project/.env` },
    }),
    `\\"password\\":\\"hunter2hunter2\\"`,
    `Cookie: session=${TOKENS.bearer}; other=1`,
    `-----BEGIN RSA PRIVATE KEY-----fixture-----END RSA PRIVATE KEY-----`,
    `opening ${HOME_DIR}/.config/orkestrator/orkestrator.sqlite`,
    ...OTHER_HOMES.map((home) => `reading ${home}/secret.txt`),
    JSON.stringify({ path: "C:\\Users\\winperson\\AppData\\x" }),
    `file:///Users/macperson/Library/x`,
    `user is fixture-user on host fixture-host`,
    `contact someone@example.com`,
    TAIL_MARKER,
  ];
}

async function writeFixtureLogs(logsDir: string): Promise<void> {
  const hostile = `${hostileLines().join("\n")}\n`;
  await fs.mkdir(path.join(logsDir, "essential"), { recursive: true });
  await fs.writeFile(path.join(logsDir, "essential", "essential.jsonl"), hostile);
  await fs.writeFile(path.join(logsDir, "essential", "essential.1.jsonl"), hostile);
  await fs.writeFile(path.join(logsDir, "orkestrator-backend-2026-11-05.log"), hostile);
  await fs.writeFile(path.join(logsDir, "orkestrator-ai-2026-11-05.1.jsonl"), hostile);
  // Files a bundle must never pick up, whatever they hold.
  await fs.writeFile(path.join(logsDir, "gateway-auth.json"), TOKENS.githubClassic);
  await fs.mkdir(path.join(logsDir, "codex-raw"), { recursive: true });
  await fs.writeFile(path.join(logsDir, "codex-raw", "raw.jsonl"), TOKENS.githubClassic);
}

function sources(logsDir: string, overrides: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  return {
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
    debugLogging: true,
    json: [
      {
        path: "metrics.json",
        description: "Metrics.",
        read: () => ({
          count: 3,
          token: 1234567,
          dataDir: `${HOME_DIR}/.config/orkestrator`,
          note: `failed with ${TOKENS.anthropic}`,
          [`key-${TOKENS.openaiLegacy}`]: true,
          nested: [{ authorization: `Bearer ${TOKENS.bearer}` }],
        }),
        absentAs: "No metrics.",
      },
      {
        path: "broken.json",
        description: "Throws.",
        read: () => {
          throw new Error("no");
        },
        absentAs: "It could not be read.",
      },
      { path: "missing.json", description: "Null.", read: () => null, absentAs: "Not running." },
    ],
    notCollected: [{ name: "prompts", reason: "Never collected." }],
    ...overrides,
  };
}

async function untar(archive: Buffer): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const reader = extract();
  const done = new Promise<void>((resolve, reject) => {
    reader.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: unknown) => {
        chunks.push(chunk as Buffer);
      });
      stream.on("end", () => {
        files.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    reader.on("finish", resolve);
    reader.on("error", reject);
  });
  reader.end(gunzipSync(archive));
  await done;
  return files;
}

function assertClean(text: string, where: string): void {
  const forbidden = [
    ...Object.values(TOKENS),
    // Pieces, so a partly removed token still fails.
    "ghp_",
    "gho_",
    "github_pat_",
    "sk-ant-",
    "sk-proj-",
    "api03",
    "hunter2",
    "Qw3rTy12",
    "M4nB5vC6",
    "A1b2C3d4",
    "zZ9zZ9",
    "PRIVATE KEY",
    HOME_DIR,
    "fixture-user",
    "fixture-host",
    "/home/",
    "/Users/",
    "\\Users\\",
    "someone@example.com",
    "somebody-else",
    "macperson",
    "winperson",
  ];
  for (const value of forbidden) {
    expect(`${where}: ${text.includes(value) ? value : "clean"}`).toBe(`${where}: clean`);
  }
}

describe("the bundle carries no credential", () => {
  test("GitHub, Anthropic and OpenAI tokens, a Bearer header and a home path are all gone", async () => {
    const logsDir = await fixtureDirectory();
    await writeFixtureLogs(logsDir);
    const { archive, manifest } = await buildDiagnosticsBundle(sources(logsDir));

    // The written bundle itself, before and after unpacking.
    const files = await untar(archive);
    assertClean(gunzipSync(archive).toString("latin1"), "the raw tar");
    for (const [name, contents] of files) assertClean(contents.toString("utf8"), name);

    // It did not pass by leaving the debug log out.
    const debug = [...files.keys()].filter((name) => name.startsWith("logs/debug/"));
    expect(debug.sort()).toEqual([
      "logs/debug/orkestrator-ai-2026-11-05.1.jsonl",
      "logs/debug/orkestrator-backend-2026-11-05.log",
    ]);
    expect(files.get("logs/debug/orkestrator-backend-2026-11-05.log")!.toString()).toContain(
      TAIL_MARKER,
    );
    expect(files.has("logs/essential/essential.jsonl")).toBe(true);
    expect(files.has("logs/essential/essential.1.jsonl")).toBe(true);
    expect(manifest.entries.every((entry) => entry.path !== "gateway-auth.json")).toBe(true);
    expect([...files.keys()].some((name) => name.includes("codex-raw"))).toBe(false);
    expect(
      manifest.entries.find((entry) => entry.path.startsWith("logs/debug/"))?.redactions,
    ).toBeGreaterThan(5);
  });

  test("a home directory shortens to ~ and keeps what is under it", async () => {
    const logsDir = await fixtureDirectory();
    await writeFixtureLogs(logsDir);
    const { archive } = await buildDiagnosticsBundle(sources(logsDir));
    const log = (await untar(archive)).get("logs/debug/orkestrator-backend-2026-11-05.log")!;
    expect(log.toString()).toContain("<data-dir>/orkestrator.sqlite");
    expect(log.toString()).toContain("~/src/secret.txt");
  });

  test("structured files stay valid JSON, with numbers kept", async () => {
    const logsDir = await fixtureDirectory();
    const { archive } = await buildDiagnosticsBundle(sources(logsDir));
    const metrics = JSON.parse((await untar(archive)).get("metrics.json")!.toString()) as Record<
      string,
      unknown
    >;
    expect(metrics.count).toBe(3);
    expect(metrics.token).toBe(1234567);
    expect(metrics.dataDir).toBe("<data-dir>");
  });

  test("a file that still matches after redaction is left out and named, never written", async () => {
    const logsDir = await fixtureDirectory();
    await writeFixtureLogs(logsDir);
    const appended = `${TOKENS.githubClassic}\n`;
    // A source of text no rule ran over stands for any rule this pass lacks.
    const { DiagnosticsRedactor } = await import("./diagnostics-redaction.js");
    const realLine = DiagnosticsRedactor.prototype.line;
    DiagnosticsRedactor.prototype.line = function (input: string) {
      return { text: appended + realLine.call(this, input).text, redactions: 0 };
    };
    try {
      const { archive, manifest } = await buildDiagnosticsBundle(sources(logsDir));
      const files = await untar(archive);
      assertClean(gunzipSync(archive).toString("latin1"), "the raw tar");
      expect([...files.keys()].filter((name) => name.startsWith("logs/"))).toEqual([]);
      expect(manifest.absent.map((item) => item.name)).toContain(
        "logs/debug/orkestrator-backend-2026-11-05.log",
      );
      expect(manifest.absent.map((item) => item.name)).toContain("logs/essential/essential.jsonl");
    } finally {
      DiagnosticsRedactor.prototype.line = realLine;
    }
  });

  test("a symbolic link is not followed into a log file's name", async () => {
    const logsDir = await fixtureDirectory();
    const outside = path.join(await fixtureDirectory(), "elsewhere.txt");
    await fs.writeFile(outside, "not a log");
    await fs.symlink(outside, path.join(logsDir, "orkestrator-backend-2026-11-05.log"));
    const { archive } = await buildDiagnosticsBundle(sources(logsDir));
    expect((await untar(archive)).size).toBeGreaterThan(0);
    expect(gunzipSync(archive).toString("latin1")).not.toContain("not a log");
  });
});

describe("the manifest is what is written", () => {
  test("every file is listed with its exact size and hash, and nothing else is in the archive", async () => {
    const logsDir = await fixtureDirectory();
    await writeFixtureLogs(logsDir);
    const { archive, manifest } = await buildDiagnosticsBundle(sources(logsDir));
    const files = await untar(archive);

    const inArchive = JSON.parse(files.get("manifest.json")!.toString()) as DiagnosticsManifest;
    expect(inArchive).toEqual(manifest);
    files.delete("manifest.json");
    expect([...files.keys()].sort()).toEqual(manifest.entries.map((entry) => entry.path).sort());
    for (const entry of manifest.entries) {
      const contents = files.get(entry.path)!;
      expect(contents.byteLength).toBe(entry.bytes);
      expect(createHash("sha256").update(contents).digest("hex")).toBe(entry.sha256);
    }
  });

  test("it says redaction is not a proof, and names what is absent and why", async () => {
    const logsDir = await fixtureDirectory();
    const { manifest } = await buildDiagnosticsBundle(sources(logsDir));
    expect(manifest.notice).toBe(DIAGNOSTICS_REDACTION_NOTICE);
    expect(manifest.notice).toContain("not a proof");
    expect(manifest.notice).toContain("Nothing is uploaded");
    const reasons = Object.fromEntries(manifest.absent.map((item) => [item.name, item.reason]));
    expect(reasons).toMatchObject({
      "broken.json": "It could not be read.",
      "missing.json": "Not running.",
      prompts: "Never collected.",
    });
    expect(reasons["logs/essential"]).toContain("No essential event log");
    expect(reasons["logs/debug"]).toContain("no log file exists");
  });

  test("with saving off, the debug log is not read, even if files remain", async () => {
    const logsDir = await fixtureDirectory();
    await writeFixtureLogs(logsDir);
    const { archive, manifest } = await buildDiagnosticsBundle(
      sources(logsDir, { debugLogging: false }),
    );
    const files = await untar(archive);
    expect([...files.keys()].some((name) => name.startsWith("logs/debug/"))).toBe(false);
    expect(files.has("logs/essential/essential.jsonl")).toBe(true);
    expect(manifest.absent.find((item) => item.name === "logs/debug")?.reason).toContain(
      "Save Logs to Disk is off",
    );
  });

  test("only the newest debug log bytes are kept, from a line start", async () => {
    const logsDir = await fixtureDirectory();
    // Redacting the full 8 MiB budget took over five seconds on a loaded host;
    // a lower budget exercises the same tail and line-start cut.
    const debugLogBytes = 64 * 1024;
    expect(debugLogBytes).toBeLessThan(DIAGNOSTICS_DEBUG_LOG_BYTES);
    const line = `${"m".repeat(70)}\n`;
    const count = Math.ceil((debugLogBytes + 4096) / line.length);
    await fs.writeFile(
      path.join(logsDir, "orkestrator-backend-2026-11-05.log"),
      `FIRST-LINE\n${line.repeat(count)}LAST-LINE\n`,
    );
    const older = path.join(logsDir, "orkestrator-backend-2026-11-04.log");
    await fs.writeFile(older, "OLDER-FILE\n");
    await fs.utimes(older, new Date(0), new Date(0));

    const { archive, manifest } = await buildDiagnosticsBundle(sources(logsDir, { debugLogBytes }));
    const log = (await untar(archive))
      .get("logs/debug/orkestrator-backend-2026-11-05.log")!
      .toString();
    expect(log.endsWith("LAST-LINE\n")).toBe(true);
    expect(log).not.toContain("FIRST-LINE");
    expect(log.startsWith("mmm")).toBe(true);
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(debugLogBytes);
    // The budget ran out on the newest file, so the older one is not read.
    expect(manifest.entries.map((entry) => entry.path)).not.toContain(
      "logs/debug/orkestrator-backend-2026-11-04.log",
    );
  });
});

describe("DiagnosticsBundles", () => {
  const built = () =>
    Promise.resolve({
      manifest: {
        createdAt: "2026-11-05T12:00:00.000Z",
        entries: [],
        absent: [],
      } as unknown as DiagnosticsManifest,
      archive: Buffer.alloc(DIAGNOSTICS_CHUNK_BYTES + 10, 7),
    });
  const plainSources = () => ({}) as DiagnosticsSources;

  test("a plan is read in order to exactly its bytes", async () => {
    const bundles = new DiagnosticsBundles({ build: built });
    const plan = await bundles.plan(plainSources);
    expect(plan.fileName).toBe("orkestrator-diagnostics-2026-11-05T12-00-00-000Z.tar.gz");
    expect(plan.archive.bytes).toBe(DIAGNOSTICS_CHUNK_BYTES + 10);

    const first = bundles.read(plan.planId, 0);
    expect(first.nextOffset).toBe(DIAGNOSTICS_CHUNK_BYTES);
    const second = bundles.read(plan.planId, first.nextOffset!);
    expect(second.nextOffset).toBeNull();
    const bytes = Buffer.concat([
      Buffer.from(first.data, "base64"),
      Buffer.from(second.data, "base64"),
    ]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(plan.archive.sha256);
    expect(() => bundles.read(plan.planId, -1)).toThrow(RangeError);
    expect(() => bundles.read(plan.planId, Number.NaN)).toThrow(RangeError);
    bundles.dispose();
  });

  test("an expired or unknown plan says so, and only two stay held", async () => {
    let now = 1_000;
    const bundles = new DiagnosticsBundles({ build: built, now: () => now, ttlMs: 100 });
    const first = await bundles.plan(plainSources);
    now += 200;
    expect(() => bundles.read(first.planId, 0)).toThrow(DiagnosticsPlanError);
    expect(() => bundles.read("nope", 0)).toThrow(DiagnosticsPlanError);

    now = 2_000;
    const a = await bundles.plan(plainSources);
    const b = await bundles.plan(plainSources);
    const c = await bundles.plan(plainSources);
    expect(() => bundles.read(a.planId, 0)).toThrow(DiagnosticsPlanError);
    expect(bundles.read(b.planId, 0).offset).toBe(0);
    expect(bundles.read(c.planId, 0).offset).toBe(0);
    bundles.dispose();
    expect(() => bundles.read(c.planId, 0)).toThrow(DiagnosticsPlanError);
  });

  test("a plan already building is joined", async () => {
    let builds = 0;
    const bundles = new DiagnosticsBundles({
      build: () => {
        builds += 1;
        return built();
      },
    });
    const [left, right] = await Promise.all([
      bundles.plan(plainSources),
      bundles.plan(plainSources),
    ]);
    expect(left.planId).toBe(right.planId);
    expect(builds).toBe(1);
    bundles.dispose();
  });

  test("a plan building for another choice is not joined", async () => {
    let builds = 0;
    const bundles = new DiagnosticsBundles({
      build: () => {
        builds += 1;
        return built();
      },
    });
    const [none, chosen, same] = await Promise.all([
      bundles.plan(plainSources),
      bundles.plan(plainSources, "env-a"),
      bundles.plan(plainSources, "env-a"),
    ]);
    expect(none.planId).not.toBe(chosen.planId);
    expect(chosen.planId).toBe(same.planId);
    expect(builds).toBe(2);
    bundles.dispose();
  });
});

test("archives remove generated multiline private keys and truncated blocks", async () => {
  const logsDir = await fixtureDirectory();
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const body = pem.split("\n").filter((line) => line && !line.startsWith("-----"));
  for (const truncated of [false, true]) {
    await fs.writeFile(
      path.join(logsDir, "orkestrator-backend-2026-11-05.log"),
      "before\n" + (truncated ? pem.slice(0, pem.indexOf("-----END")) : pem) + "after\n",
    );
    const { archive } = await buildDiagnosticsBundle(sources(logsDir));
    const log = (await untar(archive))
      .get("logs/debug/orkestrator-backend-2026-11-05.log")!
      .toString();
    expect(log).toContain("before");
    for (const line of body) expect(log).not.toContain(line);
    expect(log).not.toContain("PRIVATE KEY");
    if (!truncated) expect(log).toContain("after");
  }
});

for (const log of ["essential/essential.jsonl", "orkestrator-backend-2026-11-05.log"]) {
  for (const failure of ["open", "read"] as const) {
    test(`${log}: ${failure} failure omits only that file`, async () => {
      const directory = await fixtureDirectory();
      await writeFixtureLogs(directory);
      const target = path.join(directory, log);
      const originalOpen = fs.open.bind(fs);
      let closed = false;
      const open = spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] !== target) return originalOpen(...args);
        if (failure === "open") throw Object.assign(new Error("private path"), { code: "ENOENT" });
        const handle = await originalOpen(...args);
        spyOn(handle, "read").mockRejectedValue(
          Object.assign(new Error("private path"), { code: "EACCES" }),
        );
        const close = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation(async () => {
          closed = true;
          await close();
        });
        return handle;
      });
      try {
        const built = await buildDiagnosticsBundle(sources(directory));
        const files = await untar(built.archive);
        const manifest = JSON.parse(files.get("manifest.json")!.toString()) as DiagnosticsManifest;
        const entry = log.startsWith("essential/") ? `logs/${log}` : `logs/debug/${log}`;
        expect(files.has(entry)).toBe(false);
        expect(files.has("metrics.json")).toBe(true);
        expect(manifest.entries.some((item) => item.path.startsWith("logs/"))).toBe(true);
        expect(manifest.absent).toContainEqual({
          name: entry,
          reason: "The log file could not be read.",
        });
        if (failure === "read") expect(closed).toBe(true);
      } finally {
        open.mockRestore();
      }
    });
  }
}
