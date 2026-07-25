import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __testing } from "../../scripts/generate-codex-app-server-protocol";

const {
  normalizeGeneratedSource,
  canonicalizeJson,
  digestFiles,
  extractMethods,
  describeDifferences,
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

describe("codex app-server protocol generation", () => {
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
