import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const oxlint = join(repoRoot, "node_modules/.bin/oxlint");

// Keep the cases independent of the config: removing a group or broadening an
// exception must change the linter's result, rather than the test's expectation.
const domains = [
  { name: "nodes", privateLeaves: ["node-service.js", "node-store-format.js"], exceptions: [] },
  { name: "change-tracking", privateLeaves: ["capture.js"], exceptions: ["ledger-schema.js"] },
  {
    name: "transcript-artifacts",
    privateLeaves: ["service.js"],
    exceptions: ["store-layout.js"],
  },
  {
    name: "scheduled-jobs",
    privateLeaves: ["service.js", "store.js"],
    exceptions: ["layout.js", "tools.js"],
  },
  { name: "mcp-management", privateLeaves: ["service.js"], exceptions: [] },
  {
    name: "public-api",
    privateLeaves: ["registry.js", "attention-cursor.js", "errors.js", "revisions.js"],
    exceptions: ["dispatch.js", "exec-control.js", "operation-ledger.js"],
  },
  {
    name: "storage",
    privateLeaves: ["context.js"],
    exceptions: ["coordinators.js", "service.js", "stores.js"],
    unitExceptions: ["service.js", "stores.js", "test-support.js"],
  },
];

interface LintReport {
  number_of_files: number;
  diagnostics: {
    code: string;
    severity: string;
    labels: { span: { line: number } }[];
  }[];
}

function lintImports(importer: string, imports: string[], rejectedLines: number[]) {
  // Mirror the repository paths outside the checkout so deliberately invalid
  // imports cannot interfere with concurrent lint, format, or source scans.
  const root = mkdtempSync(join(tmpdir(), "orkestrator-domain-imports-"));
  try {
    copyFileSync(join(repoRoot, ".oxlintrc.json"), join(root, ".oxlintrc.json"));
    const file = join(root, importer);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, imports.map((specifier) => `import "${specifier}";\n`).join(""));
    const result = spawnSync(oxlint, ["--format=json", "--threads=1", importer], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(rejectedLines.length ? 1 : 0);
    const report: LintReport = JSON.parse(result.stdout);
    expect(report.number_of_files).toBe(1);
    expect(
      report.diagnostics
        .map((diagnostic) => ({
          code: diagnostic.code,
          severity: diagnostic.severity,
          line: diagnostic.labels[0]?.span.line,
        }))
        .sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    ).toEqual(
      rejectedLines.map((line) => ({
        code: "eslint(no-restricted-imports)",
        severity: "error",
        line,
      })),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("backend domain import boundaries", () => {
  for (const scope of [
    { importer: "apps/backend/src/core/boundary-probe.ts", prefix: "./", backend: true },
    {
      importer: "apps/backend/src/core/public-api/boundary-probe.ts",
      prefix: "../",
      backend: true,
    },
    {
      importer: "tests/unit/boundary-probe.test.ts",
      prefix: "../../apps/backend/src/core/",
      backend: false,
    },
  ]) {
    for (const domain of domains) {
      test(`${scope.importer}: ${domain.name} permits its index and rejects private leaves`, () => {
        const base = `${scope.prefix}${domain.name}/`;
        const exceptions = scope.backend ? domain.exceptions : (domain.unitExceptions ?? []);
        const allExceptions = Array.from(
          new Set([...domain.exceptions, ...(domain.unitExceptions ?? [])]),
        );
        const allowed = [
          `${base}index.js`,
          ...exceptions.map((leaf) => `${base}${leaf}`),
          `${scope.prefix}${domain.name}-extra/${domain.privateLeaves[0]}`,
        ];
        const blocked = [
          ...domain.privateLeaves.map((leaf) => `${base}${leaf}`),
          ...allExceptions
            .filter((leaf) => !exceptions.includes(leaf))
            .map((leaf) => `${base}${leaf}`),
          // A named cycle-breaking exception must not exempt adjacent modules.
          ...allExceptions.map((leaf) => `${base}${leaf.replace(".js", "-internal.js")}`),
        ];
        lintImports(
          scope.importer,
          [...allowed, ...blocked],
          blocked.map((_, index) => allowed.length + index + 1),
        );
      });
    }
  }

  test("backend test files retain their exemption from private domain imports", () => {
    lintImports(
      "apps/backend/src/core/boundary-probe.test.ts",
      domains.flatMap((domain) => domain.privateLeaves.map((leaf) => `./${domain.name}/${leaf}`)),
      [],
    );
  });

  test("protocol graph modules stay browser-safe", () => {
    lintImports(
      "packages/protocol/src/graphs/boundary-probe.ts",
      [
        "../field-validation.js",
        "./grammar.js",
        "node:fs",
        "bun:sqlite",
        "../testing/fake-intervals.js",
      ],
      [3, 4, 5],
    );
    lintImports("packages/protocol/src/graphs/boundary-probe.test.ts", ["bun:test"], []);
  });

  test("protocol contract modules stay browser-safe", () => {
    lintImports(
      "packages/protocol/src/contract/boundary-probe.ts",
      [
        "effect/Schema",
        "../unknown-command.js",
        "./domain.js",
        "node:fs",
        "bun:sqlite",
        "../testing/fake-pids.js",
        "../node/build-commit.js",
      ],
      [4, 5, 6, 7],
    );
    lintImports(
      "packages/protocol/src/contract/domains/boundary-probe.ts",
      ["../domain.js", "node:path", "../../testing/fake-pids.js", "../../node/build-commit.js"],
      [2, 3, 4],
    );
    lintImports("packages/protocol/src/contract/boundary-probe.test.ts", ["bun:test"], []);
  });

  test("protocol change-tracking modules retain their backend exemption", () => {
    lintImports(
      "apps/backend/src/core/boundary-probe.ts",
      ["@orkestrator/protocol/node/change-tracking/ledger-schema"],
      [],
    );
  });
});
