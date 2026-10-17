/**
 * The auth-secret canary tests cannot quietly lose coverage.
 *
 * Every bridge that serves `/global/auth`, and every backend module that turns
 * an auth answer into `NativeAgentAuthStatus`, must keep a test that plants
 * the canaries from `tests/helpers/auth-secret-canaries.ts` and checks the
 * answer and the output. A new bridge, or a parser moved to a new file, fails
 * here until it has one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseSync, visitorKeys, type Node } from "oxc-parser";

const root = path.resolve(import.meta.dir, "../..");
const HELPER = "tests/helpers/auth-secret-canaries";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (entry === "node_modules" || entry === "generated") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

function visitSource(source: string, visit: (node: Node) => void): void {
  const { program, errors } = parseSync("auth-coverage.ts", source);
  if (errors.length) throw new Error(`Cannot scan auth coverage: ${errors[0]!.message}`);
  const walk = (node: Node): void => {
    visit(node);
    for (const key of visitorKeys[node.type] ?? []) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child) walk(child as Node);
      } else if (value) walk(value as Node);
    }
  };
  walk(program);
}

// A static tripwire for assertion calls, not proof that every runtime path runs.
// Parse imports and calls so comments, strings and unused imports cannot pass.
function hasCanaryAssertions(source: string): boolean {
  if (!source.includes(HELPER)) return false;
  const bindings = new Map<string, string>();
  const calls = new Set<string>();
  visitSource(source, (node) => {
    if (node.type === "ImportDeclaration" && node.source.value.includes(HELPER)) {
      for (const specifier of node.specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
        const imported =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value;
        bindings.set(specifier.local.name, imported);
      }
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.arguments.length > 0
    ) {
      calls.add(node.callee.name);
    }
  });
  const assertions = new Set(Array.from(calls, (name) => bindings.get(name)));
  return (
    assertions.has("expectAuthStatusShape") &&
    assertions.has("expectNothingSecretLogged") &&
    (assertions.has("expectNoCanary") || assertions.has("expectOnlyLoginSecrets"))
  );
}

function servesAuth(source: string): boolean {
  if (!source.includes("/global/auth")) return false;
  let found = false;
  visitSource(source, (node) => {
    // Bun HTTP bridges compare URL.pathname instead of registering Hono routes.
    if (node.type === "BinaryExpression" && ["===", "=="].includes(node.operator)) {
      const pathname =
        node.left.type === "MemberExpression" &&
        !node.left.computed &&
        node.left.property.type === "Identifier" &&
        node.left.property.name === "pathname";
      if (pathname && node.right.type === "Literal" && node.right.value === "/global/auth")
        found = true;
      if (
        pathname &&
        node.right.type === "TemplateLiteral" &&
        node.right.expressions.length === 0 &&
        node.right.quasis[0]?.value.cooked === "/global/auth"
      )
        found = true;
    }
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
    const route = node.arguments[0];
    if (route?.type === "Literal" && route.value === "/global/auth") found = true;
    if (
      route?.type === "TemplateLiteral" &&
      route.expressions.length === 0 &&
      route.quasis[0]?.value.cooked === "/global/auth"
    )
      found = true;
  });
  return found;
}

function canaryTests(files: string[]): string[] {
  return files.filter(
    (file) => /\.test\.tsx?$/.test(file) && hasCanaryAssertions(readFileSync(file, "utf8")),
  );
}

function bridgeCoverageErrors(files: Array<{ file: string; source: string }>): string[] {
  const errors: string[] = [];
  if (!files.some(({ file, source }) => !/\.test\.tsx?$/.test(file) && servesAuth(source))) {
    errors.push("No production /global/auth route found");
  }
  if (
    !files.some(({ file, source }) => /\.test\.tsx?$/.test(file) && hasCanaryAssertions(source))
  ) {
    errors.push("No auth-secret canary assertions found");
  }
  return errors;
}

describe("auth-secret canary coverage", () => {
  const bridges = readdirSync(path.join(root, "bridges")).filter((name) =>
    name.endsWith("-bridge"),
  );

  test("finds the bridges", () => {
    expect(bridges.length).toBeGreaterThanOrEqual(5);
  });

  test.each(bridges)("%s checks its auth routes with the canaries", (bridge) => {
    const files = sourceFiles(path.join(root, "bridges", bridge, "src"));
    expect(
      bridgeCoverageErrors(files.map((file) => ({ file, source: readFileSync(file, "utf8") }))),
      bridge,
    ).toEqual([]);
  });

  test.each([
    // The bridge-answer parser for every HTTP bridge.
    ["apps/backend/src/core/http-bridge-catalog.ts", "authStatus()"],
    // OpenCode answers from its SDK, not a bridge.
    ["apps/backend/src/core/opencode-capabilities.ts", "authStatus()"],
  ])("%s keeps a canary test beside it", (relative, marker) => {
    const source = path.join(root, relative);
    expect(readFileSync(source, "utf8")).toContain(marker);
    const directory = path.dirname(source);
    const tests = canaryTests(
      readdirSync(directory).map((entry) => path.join(directory, entry)),
    ).filter((file) => {
      const text = readFileSync(file, "utf8");
      return relative.includes("opencode")
        ? text.includes("OpenCodeCapabilities")
        : text.includes("beginSignIn");
    });
    expect(tests, `${relative} has no auth-secret canary test`).not.toHaveLength(0);
  });
});

describe("auth coverage scanner fixtures", () => {
  const imports = `import { expectAuthStatusShape, expectNothingSecretLogged, expectNoCanary } from "../../tests/helpers/auth-secret-canaries.js";`;
  const covered = `${imports}
    test("auth", () => {
      expectAuthStatusShape(body);
      expectNoCanary(body, "auth");
      expectNothingSecretLogged(output, "auth");
    });`;

  test.each([
    imports,
    `${imports} // expectAuthStatusShape(body); expectNothingSecretLogged(output); expectNoCanary(body);`,
    `${imports} const example = "expectAuthStatusShape(body); expectNothingSecretLogged(output); expectNoCanary(body);";`,
    `${imports} expectAuthStatusShape(body);`,
    `${imports} expectNothingSecretLogged(output); expectNoCanary(body);`,
  ])("rejects helper mentions without the required assertions: %s", (source) => {
    expect(
      bridgeCoverageErrors([
        { file: "index.ts", source: 'app.get("/global/auth", handler);' },
        { file: "auth.test.ts", source },
      ]),
    ).toEqual(["No auth-secret canary assertions found"]);
  });

  test.each(['"', "'", "`"])("detects production auth routes quoted with %s", (quote) => {
    expect(
      bridgeCoverageErrors([
        { file: "index.ts", source: `app.get(${quote}/global/auth${quote}, handler);` },
        { file: "auth.test.ts", source: covered },
      ]),
    ).toEqual([]);
    expect(
      bridgeCoverageErrors([
        {
          file: "http.ts",
          source: `if (url.pathname === ${quote}/global/auth${quote} && request.method === "GET") respond();`,
        },
        { file: "auth.test.ts", source: covered },
      ]),
    ).toEqual([]);
  });

  test.each(["", '// app.get("/global/auth", handler);', 'const route = "/global/auth";'])(
    "rejects missing production routes: %s",
    (source) => {
      expect(
        bridgeCoverageErrors([
          { file: "index.ts", source },
          { file: "auth.test.ts", source: covered },
        ]),
      ).toEqual(["No production /global/auth route found"]);
    },
  );
});
