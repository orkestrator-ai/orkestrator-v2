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
  { name: "nodes", leaf: "node-service.js", exceptions: ["node-store-format.js"] },
  { name: "change-tracking", leaf: "capture.js", exceptions: ["ledger-schema.js"] },
  { name: "transcript-artifacts", leaf: "service.js", exceptions: ["store-layout.js"] },
  { name: "scheduled-jobs", leaf: "service.js", exceptions: ["layout.js", "store.js", "tools.js"] },
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
        const exceptions = domain.exceptions.map((leaf) => `${base}${leaf}`);
        const allowed = [
          `${base}index.js`,
          ...(scope.backend ? exceptions : []),
          `${scope.prefix}${domain.name}-extra/${domain.leaf}`,
        ];
        const blocked = [
          `${base}${domain.leaf}`,
          ...(scope.backend ? [] : exceptions),
          // A named cycle-breaking exception must not exempt adjacent modules.
          ...domain.exceptions.map((leaf) => `${base}${leaf.replace(".js", "-internal.js")}`),
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
      domains.map((domain) => `./${domain.name}/${domain.leaf}`),
      [],
    );
  });

  test("protocol change-tracking modules retain their backend exemption", () => {
    lintImports(
      "apps/backend/src/core/boundary-probe.ts",
      ["@orkestrator/protocol/node/change-tracking/ledger-schema"],
      [],
    );
  });
});
