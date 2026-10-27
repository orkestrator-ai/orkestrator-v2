import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync, visitorKeys, type Node } from "oxc-parser";

const core = path.resolve(import.meta.dir, "../../apps/backend/src/core");

function droppedCleanups(file: string, source: string): number[] {
  const { program, errors } = parseSync(file, source);
  if (errors.length) throw new Error(errors[0]!.message);
  const dropped: number[] = [];
  function visit(node: Node, parent?: Node) {
    if (node.type === "ChainExpression") {
      visit(node.expression, parent);
      return;
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "cleanup" &&
      parent?.type !== "AwaitExpression" &&
      parent?.type !== "ReturnStatement" &&
      // Returning the cleanup directly from a concise hook is also awaited by Bun.
      !(parent?.type === "ArrowFunctionExpression" && parent.body === node)
    ) {
      dropped.push(source.slice(0, node.start).split("\n").length);
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item) visit(item as Node, node);
      } else if (child) visit(child as Node, node);
    }
  }
  visit(program);
  return dropped;
}

describe("MCP fixture cleanup contract", () => {
  test("the guard rejects a dropped cleanup promise and accepts awaited or returned cleanup", () => {
    expect(droppedCleanups("fixture.test.ts", "afterEach(() => { fixture.cleanup(); });")).toEqual([
      1,
    ]);
    expect(
      droppedCleanups("fixture.test.ts", "afterEach(async () => { await fixture.cleanup(); });"),
    ).toEqual([]);
    expect(
      droppedCleanups("fixture.test.ts", "afterEach(() => { return fixture.cleanup(); });"),
    ).toEqual([]);
    expect(droppedCleanups("fixture.test.ts", "afterEach(() => fixture.cleanup());")).toEqual([]);
  });

  test("optional cleanup is still required to be awaited", () => {
    expect(droppedCleanups("fixture.test.ts", "afterEach(() => { fixture?.cleanup(); });")).toEqual(
      [1],
    );
    expect(
      droppedCleanups("fixture.test.ts", "afterEach(async () => { await fixture?.cleanup(); });"),
    ).toEqual([]);
  });

  test("every test importing createFixture from MCP test-support awaits or returns cleanup", () => {
    const failures: string[] = [];
    let callers = 0;
    for (const file of readdirSync(core, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".test.ts")) continue;
      const source = readFileSync(path.join(core, file), "utf8");
      // Covers the colocated MCP suites and command-registry callers elsewhere in core.
      const { program, errors } = parseSync(file, source);
      if (errors.length) throw new Error(`${file}: ${errors[0]!.message}`);
      const importsFixture = program.body.some(
        (node) =>
          node.type === "ImportDeclaration" &&
          (node.source.value === "./test-support.js" ||
            node.source.value.endsWith("/mcp-management/test-support.js")) &&
          node.specifiers.some(
            (specifier) =>
              specifier.type === "ImportSpecifier" &&
              specifier.imported.type === "Identifier" &&
              specifier.imported.name === "createFixture",
          ),
      );
      if (!importsFixture) continue;
      callers++;
      for (const line of droppedCleanups(file, source)) failures.push(`${file}:${line}`);
    }
    expect(callers).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  });
});
