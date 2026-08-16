import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  summarizeValue,
  truncateUtf8,
} from "../bounded-test-diagnostics";
import {
  findUnsafeDomAbsenceAssertions,
  rewriteUnsafeDomAbsenceAssertions,
} from "../dom-assertion-safety";

const root = path.resolve(import.meta.dir, "../..");
const MAX_CANARY_OUTPUT_BYTES = 64 * 1024;

async function testFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(target));
    else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(target);
  }
  return files;
}

describe("bounded test diagnostics", () => {
  test("never passes a DOM-producing query result directly to toBeNull", async () => {
    const roots = [path.join(root, "tests"), path.join(root, "apps"), path.join(root, "bridges")];
    const offenders: string[] = [];
    for (const sourceRoot of roots) {
      for (const file of await testFiles(sourceRoot)) {
        const source = await readFile(file, "utf8");
        if (findUnsafeDomAbsenceAssertions(file, source).length > 0) {
          offenders.push(path.relative(root, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("detects and faithfully rewrites DOM-producing absence assertions", () => {
    const source = [
      "expect(screen.queryByRole('button')).toBeNull();",
      "expect(container.querySelector('.spinner')).toBeNull();",
      "expect(await screen.findByRole('status')).toBeNull();",
      "expect(container.querySelectorAll('.item')[0]).toBeNull();",
      "expect(container.querySelector('.spinner')?.getAttribute('data-state')).toBeNull();",
      "expect(container.querySelector('.spinner')!.textContent).toBeNull();",
      "expect(container.querySelector('.ready')).not.toBeNull();",
    ].join("\n");

    expect(findUnsafeDomAbsenceAssertions("fixture.test.ts", source)).toHaveLength(4);
    expect(rewriteUnsafeDomAbsenceAssertions("fixture.test.ts", source)).toBe([
      "expect(screen.queryByRole('button') === null).toBe(true);",
      "expect(container.querySelector('.spinner') === null).toBe(true);",
      "expect(await screen.findByRole('status') === null).toBe(true);",
      "expect(container.querySelectorAll('.item')[0] === null).toBe(true);",
      "expect(container.querySelector('.spinner')?.getAttribute('data-state')).toBeNull();",
      "expect(container.querySelector('.spinner')!.textContent).toBeNull();",
      "expect(container.querySelector('.ready')).not.toBeNull();",
    ].join("\n"));
  });

  test("distinguishes shared references from genuine cycles", () => {
    const shared = { id: 42 };
    expect(summarizeValue({ a: shared, b: shared })).toBe(
      "Object { a: Object { id: 42 }, b: Object { id: 42 } }",
    );

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(summarizeValue(circular)).toBe("Object { self: [Circular] }");
  });

  test("bounds depth, collection size, object keys, and special collections", () => {
    expect(summarizeValue({ first: { second: { third: true } } }))
      .toBe("Object { first: Object { second: [Object] } }");
    expect(summarizeValue(Array.from({ length: 14 }, (_, index) => index)))
      .toContain("… 2 more");
    expect(summarizeValue(Object.fromEntries(
      Array.from({ length: 22 }, (_, index) => [`key${index}`, index]),
    ))).toContain("… 2 more keys");
    expect(summarizeValue(new Map([["key", "value"]]))).toBe("[Map(size=1)]");
    expect(summarizeValue(new Set([1, 2]))).toBe("[Set(size=2)]");
  });

  test("does not invoke accessors and truncates at a valid UTF-8 boundary", () => {
    const target = {};
    Object.defineProperty(target, "danger", {
      enumerable: true,
      get: () => {
        throw new Error("must not run");
      },
    });
    expect(summarizeValue(target)).toBe("Object { danger: [Accessor] }");

    const truncated = truncateUtf8("😀".repeat(100), 64);
    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(64);
    expect(truncated).not.toContain("�");
    expect(truncated).toContain("truncated at 64 bytes");
  });

  test("keeps a failing DOM console diagnostic below the byte budget", async () => {
    const child = Bun.spawn(
      ["bun", "test", "./test-fixtures/test-diagnostics/console-object-failure.test.ts"],
      { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    let bytes = 0;
    let output = "";
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > MAX_CANARY_OUTPUT_BYTES) child.kill("SIGKILL");
        if (output.length < MAX_CANARY_OUTPUT_BYTES) output += Buffer.from(chunk).toString("utf8");
      }
    };
    await Promise.all([consume(child.stdout), consume(child.stderr)]);
    const status = await child.exited;

    expect(status).not.toBe(0);
    expect(bytes).toBeLessThan(MAX_CANARY_OUTPUT_BYTES);
    expect(output).toContain("intentional diagnostic canary");
    expect(output).toContain("<button aria-label=\"Context window\">");
    expect(output).not.toContain("react-stack-top-frame");
  }, 10_000);

  test("keeps Node-only console diagnostics below the same byte budget", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "test",
        "--preload",
        "./tests/setup-node.ts",
        "./test-fixtures/test-diagnostics/console-node-object-failure.test.ts",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
      child.exited,
    ]);
    const output = Buffer.concat([Buffer.from(stdout), Buffer.from(stderr)]);

    expect(status).not.toBe(0);
    expect(output.byteLength).toBeLessThan(MAX_CANARY_OUTPUT_BYTES);
    expect(output.toString("utf8")).toContain("intentional node diagnostic canary");
  }, 10_000);

  test("assigns the browser and Node-only preload stacks to the intended workspaces", async () => {
    for (const config of ["bunfig.toml", "apps/web/bunfig.toml", "apps/web-public/bunfig.toml"]) {
      const source = await readFile(path.join(root, config), "utf8");
      expect(source).toContain("register-dom.ts");
      expect(source).toContain("setup.ts");
    }
    for (const manifest of [
      "apps/backend/package.json",
      "apps/desktop/package.json",
      "packages/cli/package.json",
      "packages/protocol/package.json",
    ]) {
      const source = await readFile(path.join(root, manifest), "utf8");
      expect(source).toContain("tests/setup-node.ts");
    }
  });
});
