import { afterAll, describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import {
  EXPECTED_PROTOCOL_OUTPUT_DIR,
  __testing,
  parseArguments,
  resolveProtocolOutputDir,
  validateVersionConfig,
} from "../../scripts/generate-codex-app-server-protocol";

const {
  normalizeGeneratedSource,
  canonicalizeJson,
  digestFiles,
  extractMethods,
  describeDifferences,
  describeCommittedSelfConsistency,
  candidateBinaries,
  generate,
  write,
} = __testing;

const repoRoot = join(import.meta.dir, "..", "..");
const generatedDir = join(
  repoRoot,
  "bridges",
  "codex-bridge",
  "src",
  "app-server",
  "generated",
);

function readGenerated(relativePath: string): string {
  return readFileSync(join(generatedDir, relativePath), "utf8");
}

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(import.meta.dir, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function fakeGeneratorBinary(mode: "empty-ts" | "empty-schema"): Promise<string> {
  const directory = await temporaryDirectory(".protocol-generator-");
  const binary = join(directory, "fake-codex");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const command = args[1];
const output = args[args.indexOf("--out") + 1];
await mkdir(output, { recursive: true });
if (command === "generate-ts" && ${JSON.stringify(mode)} !== "empty-ts") {
  await writeFile(output + "/ClientRequest.ts", 'export type X = { "method": "initialize" };');
  await writeFile(output + "/ServerNotification.ts", 'export type X = { "method": "error" };');
  await writeFile(output + "/ServerRequest.ts", 'export type X = { "method": "approval" };');
}
if (command === "generate-json-schema" && ${JSON.stringify(mode)} !== "empty-schema") {
  await writeFile(output + "/schema.json", '{"type":"object"}');
}
`,
    "utf8",
  );
  await chmod(binary, 0o755);
  return binary;
}

describe("codex app-server protocol generation", () => {
  test("accepts only the documented CLI argument shape", () => {
    expect(parseArguments([])).toEqual({ check: false });
    expect(parseArguments(["--check"])).toEqual({ check: true });
    expect(() => parseArguments(["--write"])).toThrow("usage:");
    expect(() => parseArguments(["--check", "--extra"])).toThrow("usage:");
  });

  test("requires an exact version and matching protocol source version", () => {
    expect(() =>
      validateVersionConfig({
        version: "0.145.0",
        appServerProtocol: {
          generatedFrom: "0.145.0",
          outputDir: EXPECTED_PROTOCOL_OUTPUT_DIR,
        },
      })
    ).not.toThrow();
    expect(() =>
      validateVersionConfig({
        version: "^0.145.0",
        appServerProtocol: {
          generatedFrom: "^0.145.0",
          outputDir: EXPECTED_PROTOCOL_OUTPUT_DIR,
        },
      })
    ).toThrow("exact semver");
    expect(() =>
      validateVersionConfig({
        version: "0.145.0",
        appServerProtocol: {
          generatedFrom: "0.146.0",
          outputDir: EXPECTED_PROTOCOL_OUTPUT_DIR,
        },
      })
    ).toThrow("must equal version");
  });

  test("allows the fixed output beneath the repository root", async () => {
    const root = await temporaryDirectory(".protocol-root-");
    await mkdir(join(root, "bridges", "codex-bridge", "src", "app-server"), {
      recursive: true,
    });

    expect(await resolveProtocolOutputDir(EXPECTED_PROTOCOL_OUTPUT_DIR, root))
      .toBe(resolve(root, EXPECTED_PROTOCOL_OUTPUT_DIR));
  });

  test("rejects configured output changes and symlink escapes before recursive removal", async () => {
    const root = await temporaryDirectory(".protocol-root-");
    const outside = await temporaryDirectory(".protocol-outside-");
    const parent = join(root, "bridges", "codex-bridge", "src", "app-server");
    await mkdir(parent, { recursive: true });
    await symlink(outside, join(parent, "generated"));

    await expect(
      resolveProtocolOutputDir(EXPECTED_PROTOCOL_OUTPUT_DIR, root),
    ).rejects.toThrow("resolves outside the repository");
    await expect(
      resolveProtocolOutputDir("../../outside", root),
    ).rejects.toThrow("must be");
  });

  test("replaces generated leaf symlinks without writing through them", async () => {
    const root = await temporaryDirectory(".protocol-write-root-");
    const outside = await temporaryDirectory(".protocol-write-outside-");
    const output = join(root, "generated");
    await mkdir(output, { recursive: true });
    const outsideManifest = join(outside, "manifest.json");
    const outsideReadme = join(outside, "README.md");
    await writeFile(outsideManifest, "do not overwrite");
    await writeFile(outsideReadme, "do not overwrite");
    await symlink(outsideManifest, join(output, "protocol-manifest.json"));
    await symlink(outsideReadme, join(output, "README.md"));

    const typescript = [
      { path: "ClientRequest.ts", content: 'export type X = { "method": "initialize" };' },
    ];
    await write(output, {
      typescript,
      manifest: {
        codexVersion: "0.145.0",
        typescriptDigest: digestFiles(typescript),
        schemaDigest: "sha256:schema",
        typescriptFileCount: 1,
        schemaFileCount: 1,
        clientRequestMethods: ["initialize"],
        serverNotificationMethods: [],
        serverRequestMethods: [],
      },
    });

    expect(readFileSync(outsideManifest, "utf8")).toBe("do not overwrite");
    expect(readFileSync(outsideReadme, "utf8")).toBe("do not overwrite");
    expect(JSON.parse(readFileSync(join(output, "protocol-manifest.json"), "utf8")))
      .toMatchObject({ codexVersion: "0.145.0" });
    expect(readFileSync(join(output, "README.md"), "utf8"))
      .toContain("Generated Codex app-server protocol");
  });

  test("rewrites extensionless relative specifiers so NodeNext can resolve them", () => {
    const source = [
      'import type { ClientInfo } from "./ClientInfo";',
      'import type { AbsolutePathBuf } from "../AbsolutePathBuf";',
      'import type { JsonValue } from "../serde_json/JsonValue";',
    ].join("\n");

    expect(normalizeGeneratedSource(source)).toBe(
      [
        'import type { ClientInfo } from "./ClientInfo.js";',
        'import type { AbsolutePathBuf } from "../AbsolutePathBuf.js";',
        'import type { JsonValue } from "../serde_json/JsonValue.js";',
      ].join("\n"),
    );
  });

  test("rewrites directory re-exports to an explicit index", () => {
    expect(normalizeGeneratedSource('export * as v2 from "./v2";')).toBe(
      'export * as v2 from "./v2/index.js";',
    );
  });

  test("leaves bare package specifiers and already-suffixed paths alone", () => {
    const source = [
      'import { Hono } from "hono";',
      'import type { Thread } from "./Thread.js";',
    ].join("\n");

    expect(normalizeGeneratedSource(source)).toBe(source);
  });

  test("canonicalizes schema key order so HashMap ordering cannot flap the digest", () => {
    // `codex app-server generate-json-schema` serializes definitions from a Rust
    // HashMap, so two runs of the same binary emit different key order.
    const first = JSON.stringify({
      definitions: { Beta: { type: "object" }, Alpha: { type: "string" } },
      required: ["b", "a"],
    });
    const second = JSON.stringify({
      required: ["a", "b"],
      definitions: { Alpha: { type: "string" }, Beta: { type: "object" } },
    });

    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
  });

  test("keeps enum ordering, which is meaningful", () => {
    const ordered = canonicalizeJson(JSON.stringify({ enum: ["low", "medium", "high"] }));
    expect(JSON.parse(ordered).enum).toEqual(["low", "medium", "high"]);
  });

  test("canonicalization still distinguishes a real shape change", () => {
    const before = JSON.stringify({ properties: { a: { type: "string" } } });
    const after = JSON.stringify({ properties: { a: { type: "number" } } });

    expect(canonicalizeJson(before)).not.toBe(canonicalizeJson(after));
  });

  test("digest is order-independent across files but content-sensitive", () => {
    const a = { path: "a.ts", content: "export type A = 1;" };
    const b = { path: "b.ts", content: "export type B = 2;" };

    expect(digestFiles([a, b])).toBe(digestFiles([b, a]));
    expect(digestFiles([a, b])).not.toBe(
      digestFiles([a, { path: "b.ts", content: "export type B = 3;" }]),
    );
  });

  test("extracts every method name from a generated request union", () => {
    expect(
      extractMethods(
        'export type X = { "method": "thread/start", id: RequestId } | { "method": "turn/start", id: RequestId };',
      ),
    ).toEqual(["thread/start", "turn/start"]);
  });

  test("reports stale, missing, and removed bindings plus method drift", () => {
    const manifest = {
      codexVersion: "0.145.0",
      typescriptDigest: "sha256:a",
      schemaDigest: "sha256:b",
      typescriptFileCount: 1,
      schemaFileCount: 1,
      clientRequestMethods: ["thread/start"],
      serverNotificationMethods: [],
      serverRequestMethods: [],
    };

    const problems = describeDifferences(
      {
        typescript: [
          { path: "Kept.ts", content: "new" },
          { path: "Added.ts", content: "added" },
        ],
        manifest: { ...manifest, clientRequestMethods: ["thread/start", "turn/start"] },
      },
      {
        typescript: [
          { path: "Kept.ts", content: "old" },
          { path: "Removed.ts", content: "removed" },
        ],
        manifest,
      },
    );

    expect(problems).toContain("Committed binding is stale: typescript/Kept.ts");
    expect(problems).toContain("Missing committed binding: typescript/Added.ts");
    expect(problems).toContain("Committed binding no longer generated: typescript/Removed.ts");
    expect(problems).toContain("clientRequestMethods: new method not in manifest: turn/start");
  });

  test("reports every scalar manifest difference", () => {
    const expected = {
      typescript: [{ path: "A.ts", content: "same" }],
      manifest: {
        codexVersion: "0.146.0",
        typescriptDigest: "sha256:new-ts",
        schemaDigest: "sha256:new-schema",
        typescriptFileCount: 2,
        schemaFileCount: 3,
        clientRequestMethods: [],
        serverNotificationMethods: [],
        serverRequestMethods: [],
      },
    };
    const actual = {
      typescript: [{ path: "A.ts", content: "same" }],
      manifest: {
        codexVersion: "0.145.0",
        typescriptDigest: "sha256:old-ts",
        schemaDigest: "sha256:old-schema",
        typescriptFileCount: 1,
        schemaFileCount: 1,
        clientRequestMethods: [],
        serverNotificationMethods: [],
        serverRequestMethods: [],
      },
    };

    const problems = describeDifferences(expected, actual);
    for (const scalar of [
      "codexVersion",
      "typescriptFileCount",
      "schemaFileCount",
      "TypeScript binding digest",
      "JSON Schema digest",
    ]) {
      expect(problems.some((problem) => problem.includes(scalar))).toBe(true);
    }
  });

  test("offline consistency checks version, tree digest, count, and method surfaces", () => {
    const typescript = [
      {
        path: "ClientRequest.ts",
        content: 'export type X = { "method": "thread/start" };',
      },
      {
        path: "ServerNotification.ts",
        content: 'export type X = { "method": "turn/completed" };',
      },
      {
        path: "ServerRequest.ts",
        content: 'export type X = { "method": "approval" };',
      },
    ];
    const committed = {
      typescript,
      manifest: {
        codexVersion: "0.144.0",
        typescriptDigest: "sha256:stale",
        schemaDigest: "sha256:schema",
        typescriptFileCount: 2,
        schemaFileCount: 1,
        clientRequestMethods: ["wrong"],
        serverNotificationMethods: ["turn/completed"],
        serverRequestMethods: ["approval"],
      },
    };

    const problems = describeCommittedSelfConsistency(committed, "0.145.0");
    expect(problems.some((problem) => problem.includes("codexVersion"))).toBe(true);
    expect(problems.some((problem) => problem.includes("digest"))).toBe(true);
    expect(problems.some((problem) => problem.includes("typescriptFileCount"))).toBe(true);
    expect(problems.some((problem) => problem.includes("clientRequestMethods"))).toBe(true);

    committed.manifest = {
      ...committed.manifest,
      codexVersion: "0.145.0",
      typescriptDigest: digestFiles(typescript),
      typescriptFileCount: typescript.length,
      clientRequestMethods: ["thread/start"],
    };
    expect(describeCommittedSelfConsistency(committed, "0.145.0")).toEqual([]);
  });

  test("fails when TypeScript generation produces no files", async () => {
    const binary = await fakeGeneratorBinary("empty-ts");
    await expect(generate(binary, "0.145.0")).rejects.toThrow(
      "generate-ts produced no files",
    );
  });

  test("fails when schema generation produces no files", async () => {
    const binary = await fakeGeneratorBinary("empty-schema");
    await expect(generate(binary, "0.145.0")).rejects.toThrow(
      "generate-json-schema produced no files",
    );
  });

  test("identical input produces no differences", () => {
    const snapshot = {
      typescript: [{ path: "A.ts", content: "export type A = 1;" }],
      manifest: {
        codexVersion: "0.145.0",
        typescriptDigest: "sha256:a",
        schemaDigest: "sha256:b",
        typescriptFileCount: 1,
        schemaFileCount: 1,
        clientRequestMethods: ["initialize"],
        serverNotificationMethods: ["error"],
        serverRequestMethods: [],
      },
    };

    expect(describeDifferences(snapshot, snapshot)).toEqual([]);
  });
});

describe("generator binary resolution", () => {
  const scriptPath = join(repoRoot, "scripts", "generate-codex-app-server-protocol.ts");

  async function runCheck(env: Record<string, string>): Promise<{ code: number; output: string }> {
    const proc = Bun.spawn(["bun", scriptPath, "--check"], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, output: `${stdout}${stderr}` };
  }

  test("a stale CODEX_PATH still falls back to codex on PATH", () => {
    expect(candidateBinaries("0.145.0", {
      platform: "linux",
      architecture: "x64",
      homeDirectory: "/home/tester",
      xdgConfigHome: "/config",
      codexPath: "/stale/codex",
    })).toEqual([
      "/config/orkestrator-v2/toolchains/codex/0.145.0/linux-x64/codex",
      "/stale/codex",
      "codex",
    ]);
  });

  const DARWIN_ROOT = "/Users/tester/Library/Application Support/orkestrator-v2/toolchains";

  for (const scenario of [
    {
      name: "darwin resolves the managed root under Application Support",
      options: { platform: "darwin" as const, architecture: "arm64", homeDirectory: "/Users/tester" },
      expected: [`${DARWIN_ROOT}/codex/0.145.0/darwin-arm64/codex`, "codex"],
    },
    {
      name: "darwin x64 keeps its own managed directory",
      options: { platform: "darwin" as const, architecture: "x64", homeDirectory: "/Users/tester" },
      expected: [`${DARWIN_ROOT}/codex/0.145.0/darwin-x64/codex`, "codex"],
    },
    {
      // The installer only publishes arm64 and x64 builds, so anything else has
      // to resolve somewhere rather than producing a `codex-ia32` path that can
      // never exist.
      name: "an unknown architecture falls back to the x64 build",
      options: { platform: "linux" as const, architecture: "ia32", homeDirectory: "/home/t", xdgConfigHome: "/cfg" },
      expected: ["/cfg/orkestrator-v2/toolchains/codex/0.145.0/linux-x64/codex", "codex"],
    },
    {
      name: "a non-darwin platform uses the XDG config root",
      options: { platform: "freebsd" as const, architecture: "arm64", homeDirectory: "/home/t", xdgConfigHome: "/cfg" },
      expected: ["/cfg/orkestrator-v2/toolchains/codex/0.145.0/linux-arm64/codex", "codex"],
    },
    {
      name: "an explicit CODEX_PATH is tried after the managed copy",
      options: {
        platform: "linux" as const,
        architecture: "arm64",
        homeDirectory: "/home/t",
        xdgConfigHome: "/cfg",
        codexPath: "  /opt/codex  ",
      },
      expected: ["/cfg/orkestrator-v2/toolchains/codex/0.145.0/linux-arm64/codex", "/opt/codex", "codex"],
    },
    {
      // Regression: an exported-but-empty CODEX_PATH used to be pushed verbatim,
      // so resolution tried to execute "" and reported a confusing failure for
      // every candidate after it.
      name: "a blank CODEX_PATH is ignored rather than tried",
      options: {
        platform: "linux" as const,
        architecture: "arm64",
        homeDirectory: "/home/t",
        xdgConfigHome: "/cfg",
        codexPath: "   ",
      },
      expected: ["/cfg/orkestrator-v2/toolchains/codex/0.145.0/linux-arm64/codex", "codex"],
    },
    {
      name: "an empty CODEX_PATH is ignored rather than tried",
      options: {
        platform: "linux" as const,
        architecture: "arm64",
        homeDirectory: "/home/t",
        xdgConfigHome: "/cfg",
        codexPath: "",
      },
      expected: ["/cfg/orkestrator-v2/toolchains/codex/0.145.0/linux-arm64/codex", "codex"],
    },
  ]) {
    test(`candidateBinaries: ${scenario.name}`, () => {
      const previous = process.env.CODEX_PATH;
      delete process.env.CODEX_PATH;
      try {
        expect(candidateBinaries("0.145.0", scenario.options)).toEqual(scenario.expected);
      } finally {
        if (previous === undefined) delete process.env.CODEX_PATH;
        else process.env.CODEX_PATH = previous;
      }
    });
  }

  test("candidateBinaries falls back to the ambient platform, arch, home, and CODEX_PATH", () => {
    const previousCodexPath = process.env.CODEX_PATH;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.CODEX_PATH = "/from/env/codex";
    process.env.XDG_CONFIG_HOME = "/xdg-from-env";
    try {
      const candidates = candidateBinaries("0.145.0");
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const expectedRoot = platform() === "darwin"
        ? join(homedir(), "Library", "Application Support", "orkestrator-v2", "toolchains")
        : join("/xdg-from-env", "orkestrator-v2", "toolchains");

      expect(candidates).toEqual([
        join(expectedRoot, "codex", "0.145.0", `${platform() === "darwin" ? "darwin" : "linux"}-${arch}`, "codex"),
        "/from/env/codex",
        "codex",
      ]);

      // A blank environment value is skipped just like a blank option.
      process.env.CODEX_PATH = "  ";
      expect(candidateBinaries("0.145.0")).toHaveLength(2);
    } finally {
      if (previousCodexPath === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = previousCodexPath;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  /**
   * An explicit override is an assertion, not a hint. Falling back to
   * auto-discovery would be dangerous during an upgrade: point at the new binary
   * but forget to bump the pinned version, and bindings would be generated from
   * the *old* managed binary — which then match the committed artifacts and pass
   * `--check`, hiding the mistake.
   */
  test("a nonexistent CODEX_PROTOCOL_BINARY fails instead of falling back", async () => {
    const result = await runCheck({ CODEX_PROTOCOL_BINARY: "/definitely/not/here/codex" });

    expect(result.code).toBe(1);
    expect(result.output).toContain("CODEX_PROTOCOL_BINARY does not exist");
    // Must not have quietly resolved some other binary.
    expect(result.output).not.toContain("match the pinned binary");
  });

  test("a non-executable CODEX_PROTOCOL_BINARY fails clearly", async () => {
    const result = await runCheck({
      CODEX_PROTOCOL_BINARY: join(repoRoot, "config", "codex-version.json"),
    });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/could not be executed|reports/);
    expect(result.output).not.toContain("match the pinned binary");
  });
});

describe("committed protocol bindings", () => {
  test("import specifiers are all resolvable under NodeNext", () => {
    // A single extensionless relative specifier anywhere in the tree breaks
    // `tsc --noEmit` for the whole bridge, so assert the invariant directly.
    const offenders: string[] = [];
    for (const relativePath of ["index.ts", "ClientRequest.ts", "v2/index.ts"]) {
      const source = readGenerated(join("typescript", relativePath));
      for (const match of source.matchAll(/from\s+"(\.[^"]*)"/g)) {
        if (!match[1]!.endsWith(".js")) offenders.push(`${relativePath}: ${match[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the union types the bridge switches on are present", () => {
    expect(readGenerated(join("typescript", "ClientRequest.ts"))).toContain('"thread/start"');
    expect(readGenerated(join("typescript", "ServerNotification.ts"))).toContain('"turn/completed"');
    expect(readGenerated(join("typescript", "ServerRequest.ts"))).toContain(
      '"item/commandExecution/requestApproval"',
    );
  });

  test("turn/start carries clientUserMessageId, the at-most-once dispatch key", () => {
    // The whole idempotency design depends on this field surviving a version
    // bump: it is what lets recovery find an already-dispatched turn.
    expect(readGenerated(join("typescript", "v2", "TurnStartParams.ts"))).toContain(
      "clientUserMessageId",
    );
    // ...and on `userMessage` items echoing it back as `clientId`.
    const threadItem = readGenerated(join("typescript", "v2", "ThreadItem.ts"));
    expect(threadItem).toContain('"userMessage"');
    expect(threadItem).toContain("clientId");
  });

  test("thread/list still exposes the root source kinds history filtering needs", () => {
    // Omitting sourceKinds silently returns zero threads, which would empty the
    // resume dialog. Guard the exact kinds the bridge asks for.
    const sourceKind = readGenerated(join("typescript", "v2", "ThreadSourceKind.ts"));
    for (const kind of ["cli", "vscode", "exec", "appServer", "unknown", "subAgent"]) {
      expect(sourceKind).toContain(`"${kind}"`);
    }
  });
});
