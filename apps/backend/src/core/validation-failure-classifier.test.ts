import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isValidationFailureTriage,
  validationFailureKey,
  type ValidationFailureTriage,
} from "@orkestrator/protocol/validation-failure-triage";
import {
  VALIDATION_FAILURE_CLASSIFIER_SCRIPT,
  type ValidationFailureClassifierCommand,
  type ValidationFailureClassifierInput,
} from "./validation-failure-classifier.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway tree (not a Git checkout, so the classifier walks it). */
function fixture(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "validation-triage-")));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
  return root;
}

/**
 * Runs the exact source shipped into environments, so a reference to anything
 * outside the function body fails here rather than in a container.
 */
function classify(
  root: string,
  overrides: Partial<ValidationFailureClassifierInput> & {
    output?: string;
    status?: ValidationFailureClassifierCommand["status"];
  } = {},
): ValidationFailureTriage {
  const { output, status, ...rest } = overrides;
  if (output !== undefined) writeFileSync(path.join(root, "out.txt"), output);
  const input: ValidationFailureClassifierInput = {
    root,
    commands: [
      {
        command: "cd '.' && mise run test",
        cwd: ".",
        status: status ?? "failed",
        stdoutPath: "out.txt",
        stderrPath: null,
      },
    ],
    changedFiles: [],
    mergeBase: null,
    ci: null,
    budgetMs: 20_000,
    ...rest,
  };
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
  const result = Bun.spawnSync(
    [process.execPath, "-e", VALIDATION_FAILURE_CLASSIFIER_SCRIPT, encoded],
    {
      cwd: "/",
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const triage: unknown = JSON.parse(result.stdout.toString());
  expect(isValidationFailureTriage(triage)).toBe(true);
  return triage as ValidationFailureTriage;
}

function failures(triage: ValidationFailureTriage) {
  return triage.commands.flatMap((command) => command.failures);
}

const MODULES = {
  "apps/backend/package.json": JSON.stringify({ name: "@acme/backend" }),
  "apps/backend/src/pool.ts": "export const pool = 1;\n",
  "apps/backend/src/pool.test.ts": [
    'import { test } from "bun:test";',
    'import { pool } from "./pool";',
    'test("idle connections expire", () => {});',
  ].join("\n"),
  "apps/backend/src/close.ts": "export const close = 1;\n",
  "apps/backend/src/close.test.ts": [
    'import { describe, test } from "bun:test";',
    'import { close } from "./close";',
    'describe("Coordinator conversations", () => {',
    '  test("a queued run is retired by the real close path", () => {});',
    "});",
  ].join("\n"),
};

function bunAggregate(root: string, failTotal = 2): string {
  const prefix = "@acme/backend:test:workspace: ";
  return [
    `${prefix}src/pool.test.ts:`,
    // The nearest header is pool.test.ts, but the stack names close.test.ts:
    // a parallel run interleaved the two files.
    `${prefix}error: expect(received).toEqual(expected)`,
    `${prefix}      at <anonymous> (${root}/apps/backend/src/close.test.ts:4:3)`,
    `${prefix}(fail) Coordinator conversations > a queued run is retired by the real close path [542.58ms]`,
    `${prefix}src/pool.test.ts:`,
    `${prefix}      at closed (${root}/apps/backend/src/pool.test.ts:3:1)`,
    `${prefix}(fail) idle connections expire [706.63ms]`,
    `${prefix} 13339 pass`,
    `${prefix} ${failTotal} fail`,
    `${prefix}Ran 13341 tests across 898 files. [356.59s]`,
    `${prefix}error: script "test:workspace" exited with code 1`,
  ].join("\n");
}

describe("bun output", () => {
  test("classifies each failing test by whether it reaches a changed file", () => {
    const root = fixture(MODULES);
    const triage = classify(root, {
      output: bunAggregate(root),
      changedFiles: ["apps/backend/src/close.ts"],
    });
    const [command] = triage.commands;
    expect(command!.unattributed).toBe(false);
    const byFile = Object.fromEntries(failures(triage).map((failure) => [failure.file, failure]));
    expect(byFile["apps/backend/src/close.test.ts"]).toMatchObject({
      verdict: "related",
      reasons: ["imports-changed-file"],
      changedPath: "apps/backend/src/close.ts",
      name: "Coordinator conversations > a queued run is retired by the real close path",
    });
    expect(byFile["apps/backend/src/pool.test.ts"]).toMatchObject({
      verdict: "unrelated",
      reasons: ["no-changed-dependency"],
    });
    // The key is the protocol's, so other runs and CI logs match it.
    expect(byFile["apps/backend/src/pool.test.ts"]!.key).toBe(
      validationFailureKey("bun", "apps/backend/src/pool.test.ts", "idle connections expire"),
    );
  });

  test("a changed test file is related", () => {
    const root = fixture(MODULES);
    const triage = classify(root, {
      output: bunAggregate(root),
      changedFiles: ["apps/backend/src/pool.test.ts"],
    });
    const pool = failures(triage).find((f) => f.file === "apps/backend/src/pool.test.ts");
    expect(pool).toMatchObject({ verdict: "related", reasons: ["test-file-changed"] });
  });

  test("a count the listed tests do not match leaves the command unattributed", () => {
    const root = fixture(MODULES);
    const triage = classify(root, { output: bunAggregate(root, 3) });
    expect(triage.commands[0]).toMatchObject({ unattributed: true });
    expect(triage.commands[0]!.unattributedReason).toContain("Bun counted 3");
  });

  test("a test that names a changed directory is related, and the verdict names that directory", () => {
    const root = fixture({
      "tests/todo-index.test.ts": [
        'import { test } from "bun:test";',
        'const directory = join(root, "docs/todo");',
        'test("every todo is indexed", () => {});',
      ].join("\n"),
    });
    const triage = classify(root, {
      output: [
        "tests/todo-index.test.ts:",
        "(fail) every todo is indexed",
        " 0 pass",
        " 1 fail",
      ].join("\n"),
      changedFiles: ["docs/todo/cross-cutting/2921-browser-failures.md"],
    });
    expect(failures(triage)[0]).toMatchObject({
      verdict: "related",
      reasons: ["references-changed-path"],
      changedPath: "docs/todo",
    });
  });

  test("configuration every test loads makes an untouched test undetermined", () => {
    const root = fixture(MODULES);
    const triage = classify(root, {
      output: bunAggregate(root),
      changedFiles: ["package.json"],
    });
    expect(failures(triage).map((failure) => failure.verdict)).toEqual([
      "undetermined",
      "undetermined",
    ]);
    expect(failures(triage)[0]!.reasons).toEqual(["global-change"]);
  });

  test("a bunfig preload's imports count as every test's own", () => {
    const root = fixture({
      ...MODULES,
      "bunfig.toml": '[test]\npreload = ["./tests/setup.ts"]\n',
      "tests/setup.ts": 'import "./mocks";\n',
      "tests/mocks.ts": "export {};\n",
    });
    const triage = classify(root, {
      output: bunAggregate(root),
      changedFiles: ["tests/mocks.ts"],
    });
    expect(failures(triage).every((failure) => failure.verdict === "related")).toBe(true);
  });

  test("an unresolvable local import leaves the test undetermined", () => {
    const root = fixture({
      "src/a.test.ts":
        'import { missing } from "./missing";\ntest("loads a missing module", () => {});\n',
    });
    const triage = classify(root, {
      output: ["src/a.test.ts:", "(fail) loads a missing module", " 1 fail"].join("\n"),
      changedFiles: ["src/elsewhere.ts"],
    });
    expect(failures(triage)[0]).toMatchObject({
      verdict: "undetermined",
      reasons: ["dependency-graph-incomplete"],
    });
  });

  test("output that names no test (a type error) is unattributed", () => {
    const root = fixture({});
    const triage = classify(root, { output: "src/a.ts(3,1): error TS2322: Type 'x'\n" });
    expect(triage.commands[0]).toMatchObject({ failures: [], unattributed: true });
  });

  test("an incomplete command is unattributed even when tests are listed", () => {
    const root = fixture(MODULES);
    const triage = classify(root, { output: bunAggregate(root), status: "incomplete" });
    expect(triage.commands[0]!.unattributed).toBe(true);
    expect(triage.commands[0]!.unattributedReason).toContain("did not finish");
  });
});

/**
 * To-do 4520 changed only `apps/web/src/hooks/` and documents, yet 17 backend
 * and CLI failures were triaged `related`: each test's import graph reached
 * `packages/protocol/src/web-annotations.ts`, whose doc comment names
 * `apps/web` as an example.
 */
describe("paths named outside a test and its helpers", () => {
  const CHANGED_4520 = [
    "apps/web/src/hooks/native-agent-live-head.test.ts",
    "apps/web/src/hooks/native-agent-live-head.ts",
    "apps/web/src/hooks/useNativeAgentSession.sync.test.tsx",
    "docs/todo/cross-cutting/1202-efficiency-review-follow-ups.md",
    "docs/todo/transcripts-and-observation/0000-index.md",
    "docs/todo/transcripts-and-observation/4520-live-head-omitted-count-duplicate-part.md",
  ];
  const WEB_ANNOTATIONS = [
    "/**",
    " * - `root` meta (`<meta name=… content=…>`): the producing project's",
    " *   directory relative to the environment workspace, for example `apps/web`;",
    " *   absent means the workspace root.",
    " */",
    'export const SOURCE_HINT_ROOT_META = "orkestrator-source-root";',
  ].join("\n");
  const OUTPUT = [
    "apps/backend/tests/container-readiness.test.ts:",
    "(fail) bounded in-container boot wait > a pending shell probe is clipped to the remaining overall deadline",
    " 0 pass",
    " 1 fail",
  ].join("\n");
  function tree(overrides: Record<string, string> = {}): string {
    return fixture({
      "packages/protocol/package.json": JSON.stringify({ name: "@acme/protocol" }),
      "packages/protocol/src/web-annotations.ts": WEB_ANNOTATIONS,
      "apps/backend/src/core/container-readiness.ts": [
        'import { SOURCE_HINT_ROOT_META } from "../../../../packages/protocol/src/web-annotations";',
        "export const meta = SOURCE_HINT_ROOT_META;",
      ].join("\n"),
      "apps/backend/tests/container-readiness.test.ts": [
        'import { test } from "bun:test";',
        'import { meta } from "../src/core/container-readiness";',
        'test("a pending shell probe is clipped to the remaining overall deadline", () => {});',
      ].join("\n"),
      ...overrides,
    });
  }

  test("a directory named in a production module's doc comment is not a reference", () => {
    const triage = classify(tree(), { output: OUTPUT, changedFiles: CHANGED_4520 });
    expect(failures(triage)[0]).toMatchObject({
      file: "apps/backend/tests/container-readiness.test.ts",
      verdict: "unrelated",
      reasons: ["no-changed-dependency"],
    });
    expect(failures(triage)[0]!.changedPath).toBeUndefined();
  });

  test("a directory or basename in a production module's code is not a reference", () => {
    const root = tree({
      "apps/backend/src/core/container-readiness.ts": [
        'import { SOURCE_HINT_ROOT_META } from "../../../../packages/protocol/src/web-annotations";',
        'export const webRoot = "apps/web";',
        'export const head = "native-agent-live-head.ts";',
        "export const meta = SOURCE_HINT_ROOT_META;",
      ].join("\n"),
    });
    const triage = classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 });
    expect(failures(triage)[0]).toMatchObject({
      verdict: "unrelated",
      reasons: ["no-changed-dependency"],
    });
  });

  test("a changed file's full path in a production module's code is still a reference", () => {
    const root = tree({
      "apps/backend/src/core/container-readiness.ts": [
        'import { readFileSync } from "node:fs";',
        'export const head = readFileSync("apps/web/src/hooks/native-agent-live-head.ts", "utf8");',
      ].join("\n"),
    });
    const triage = classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 });
    expect(failures(triage)[0]).toMatchObject({
      verdict: "related",
      reasons: ["references-changed-path"],
      changedPath: "apps/web/src/hooks/native-agent-live-head.ts",
    });
  });

  test("a changed file's full path in a production module's comment is not a reference", () => {
    const root = tree({
      "apps/backend/src/core/container-readiness.ts": [
        "// Mirrors apps/web/src/hooks/native-agent-live-head.ts.",
        "export const meta = 1;",
      ].join("\n"),
    });
    const triage = classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 });
    expect(failures(triage)[0]!.verdict).toBe("unrelated");
  });

  test("a directory a test helper names is a reference", () => {
    const root = tree({
      "apps/backend/tests/container-readiness.test.ts": [
        'import { test } from "bun:test";',
        'import { webRoot } from "./web-fixture-test-support";',
        'test("a pending shell probe is clipped to the remaining overall deadline", () => {});',
      ].join("\n"),
      "apps/backend/tests/web-fixture-test-support.ts":
        'import { join } from "node:path";\nexport const webRoot = join(process.cwd(), "apps/web");\n',
    });
    const triage = classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 });
    expect(failures(triage)[0]).toMatchObject({
      verdict: "related",
      reasons: ["references-changed-path"],
      changedPath: "apps/web",
    });
  });

  test("a directory named only in the test file's own comment is not a reference", () => {
    const root = tree({
      "apps/backend/tests/container-readiness.test.ts": [
        'import { test } from "bun:test";',
        '// Unlike "apps/web", the backend has no live head.',
        'test("a pending shell probe is clipped to the remaining overall deadline", () => {});',
      ].join("\n"),
    });
    const triage = classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 });
    expect(failures(triage)[0]!.verdict).toBe("unrelated");
  });

  test("a preload every test loads is not one test's own helper", () => {
    const root = tree({
      "apps/backend/bunfig.toml": '[test]\npreload = ["./tests/setup.ts"]\n',
      "apps/backend/tests/setup.ts": 'export const webRoot = "apps/web";\n',
    });
    const triage = classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 });
    expect(failures(triage)[0]).toMatchObject({
      verdict: "unrelated",
      reasons: ["no-changed-dependency"],
    });
  });

  for (const location of ["test", "helper", "production"] as const) {
    test(`a preserved legal comment in a ${location} is not path evidence`, () => {
      const file =
        location === "test"
          ? "apps/backend/tests/container-readiness.test.ts"
          : location === "helper"
            ? "apps/backend/src/core/readiness-test-support.ts"
            : "apps/backend/src/core/container-readiness.ts";
      const literal =
        location === "production" ? "apps/web/src/hooks/native-agent-live-head.ts" : "apps/web";
      const root = tree({
        "apps/backend/tests/container-readiness.test.ts": [
          ...(location === "test" ? [] : [`import "../src/core/${path.basename(file)}";`]),
          'test("a pending shell probe is clipped to the remaining overall deadline", () => {});',
        ].join("\n"),
        [file]: [
          `/*! "${literal}" */`,
          "export const value = 1;",
          ...(location === "test"
            ? [
                'test("a pending shell probe is clipped to the remaining overall deadline", () => {});',
              ]
            : []),
        ].join("\n"),
      });
      expect(
        failures(classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 }))[0],
      ).toMatchObject({
        verdict: "unrelated",
        reasons: ["no-changed-dependency"],
      });
    });
  }

  for (const expression of [
    '"apps/web"',
    "'/* \"apps/web\" */'",
    "'// \"apps/web\"'",
    "`apps/web`",
    "`apps/web/**/${name}`",
    "`apps/web/**/${`${name}`}`",
    "`apps/web/**/${({ name }).name}`",
    '`apps/web/**/${"/* text */"}`',
  ]) {
    test(`real path text survives comment removal in ${expression}`, () => {
      const root = tree({
        "apps/backend/tests/container-readiness.test.ts": [
          '/*! "unrelated/legal/path" */',
          `const directory = ${expression};`,
          'const markers = "/* not a comment */ // nor is this";',
          'const escaped = "\\\"/* still a string */\\\"";',
          'test("a pending shell probe is clipped to the remaining overall deadline", () => {});',
        ].join("\n"),
      });
      expect(
        failures(classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 }))[0],
      ).toMatchObject({
        verdict: "related",
        reasons: ["references-changed-path"],
        changedPath: "apps/web",
      });
    });
  }

  test("legal comments inside template expressions cannot become path evidence", () => {
    const root = tree({
      "apps/backend/tests/container-readiness.test.ts": [
        'const description = `text ${(() => { /*! "apps/web" */ return name; })()}`;',
        'test("a pending shell probe is clipped to the remaining overall deadline", () => {});',
      ].join("\n"),
    });
    expect(
      failures(classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 }))[0]!.verdict,
    ).toBe("unrelated");
  });

  test("unsupported Flow syntax in a Jest test leaves path analysis unavailable", () => {
    const root = fixture({
      "tests/example.test.js": [
        '// "apps/web"',
        "opaque type ID = string;",
        'test("works", () => {});',
      ].join("\n"),
    });
    const result = classify(root, {
      output: "FAIL tests/example.test.js\n  ● works\nTests: 1 failed, 1 total",
      changedFiles: ["apps/web/src/hooks/head.ts"],
    });
    expect(failures(result)[0]).toMatchObject({
      runner: "jest",
      verdict: "undetermined",
      reasons: ["dependency-graph-incomplete"],
    });
    expect(failures(result)[0]!.changedPath).toBeUndefined();
  });

  test("ambiguous regexp tokens cannot expose comment-like path text", () => {
    const root = tree({
      "apps/backend/tests/container-readiness.test.ts": [
        '/*! "apps/web" */',
        "const pattern = /[/*]/;",
        'test("a pending shell probe is clipped to the remaining overall deadline", () => {});',
      ].join("\n"),
    });
    expect(
      failures(classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 }))[0],
    ).toMatchObject({
      verdict: "undetermined",
      reasons: ["dependency-graph-incomplete"],
    });
  });

  for (const [basename, verdict] of [
    ["agent-test-cursor-credential.ts", "related"],
    ["agent-contest-cursor-credential.ts", "unrelated"],
    ["agent-fixture-support.ts", "related"],
  ]) {
    test(`helper basename heuristic classifies ${basename} as ${verdict}`, () => {
      const root = tree({
        "apps/backend/src/core/container-readiness.ts": `import "./${basename}";\nexport const meta = 1;`,
        [`apps/backend/src/core/${basename}`]: 'export const directory = "apps/web";',
      });
      expect(
        failures(classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 }))[0],
      ).toMatchObject({
        verdict,
        reasons: [verdict === "related" ? "references-changed-path" : "no-changed-dependency"],
      });
    });
  }

  test("a helper reached through a production module is the test's own helper", () => {
    const root = tree({
      "apps/backend/src/core/container-readiness.ts": 'import "../../tests/readiness-support";',
      "apps/backend/tests/readiness-support.ts": 'export const directory = "apps/web";',
    });
    expect(
      failures(classify(root, { output: OUTPUT, changedFiles: CHANGED_4520 }))[0],
    ).toMatchObject({
      verdict: "related",
      reasons: ["references-changed-path"],
      changedPath: "apps/web",
    });
  });
});

describe("playwright output", () => {
  const output = [
    "  1) [desktop-chromium] › e2e/Settings.spec.ts:3:1 › Log Detail offers live areas ─────",
    "  2 failed",
    "    [mobile-chromium] › e2e/Settings.spec.ts:3:1 › Log Detail offers live areas ",
    "    [desktop-chromium] › e2e/Settings.spec.ts:3:1 › Log Detail offers live areas ",
    "  1 flaky",
    "    [desktop-chromium] › e2e/ToolGroup.spec.ts:442:1 › a waiting group follows calls ",
    "  117 skipped",
    "  1147 passed (11.1m)",
  ].join("\n");

  test("a test that passed on retry is unrelated; a failed spec is undetermined", () => {
    const root = fixture({ "e2e/Settings.spec.ts": "", "e2e/ToolGroup.spec.ts": "" });
    const triage = classify(root, { output, changedFiles: ["apps/web/src/a.tsx"] });
    expect(triage.commands[0]!.unattributed).toBe(false);
    expect(failures(triage)).toEqual([
      expect.objectContaining({
        runner: "playwright",
        file: "e2e/Settings.spec.ts",
        name: "Log Detail offers live areas",
        outcome: "failed",
        verdict: "undetermined",
        reasons: ["not-import-traceable"],
      }),
      expect.objectContaining({
        file: "e2e/ToolGroup.spec.ts",
        outcome: "flaky",
        verdict: "unrelated",
        reasons: ["passed-on-retry", "not-import-traceable"],
      }),
    ]);
  });

  test("an open flake-registry row is context, not proof of a flake", () => {
    const root = fixture({
      "e2e/Settings.spec.ts": "",
      "e2e/ToolGroup.spec.ts": "",
      "docs/tests/flaky-tests/web-ui/0000-index.md": [
        "| ID | Status | Test | File | Symptom | Case |",
        "| --- | --- | --- | --- | --- | --- |",
        "| 0001 | open | `Log Detail offers live areas` | e2e/Settings.spec.ts:3 | count | [x](x.md) |",
        "| 0002 | resolved | `a waiting group follows calls` | e2e/ToolGroup.spec.ts | x | [y](y.md) |",
      ].join("\n"),
    });
    const triage = classify(root, { output });
    expect(failures(triage)[0]).toMatchObject({
      verdict: "undetermined",
      reasons: ["known-flaky", "not-import-traceable"],
    });
  });
});

describe("other runners", () => {
  test("vitest, jest and pytest failures are named", () => {
    const root = fixture({
      "src/a.test.ts": 'test("adds", () => {});',
      "src/b.test.js": 'test("subtracts", () => {});',
      "tests/test_c.py": "",
    });
    const output = [
      " FAIL  src/a.test.ts > math > adds",
      "      Tests  1 failed | 4 passed (5)",
      "FAIL src/b.test.js",
      "  ● math › subtracts",
      "Tests:       1 failed, 3 passed, 4 total",
      "FAILED tests/test_c.py::test_divides - AssertionError",
      "========= 1 failed, 2 passed in 0.12s =========",
    ].join("\n");
    const triage = classify(root, { output });
    expect(failures(triage).map((f) => [f.runner, f.file, f.name])).toEqual([
      ["vitest", "src/a.test.ts", "math > adds"],
      ["jest", "src/b.test.js", "math › subtracts"],
      ["pytest", "tests/test_c.py", "test_divides"],
    ]);
    expect(triage.commands[0]!.unattributed).toBe(false);
  });
});

describe("the target branch's CI", () => {
  /**
   * A stand-in for `gh api`. `legacy` rejects `--allow-escape-sequences`, as
   * a gh from before that flag does.
   */
  function fakeGh(root: string, mergeBase: string, options: { legacy?: boolean } = {}): string {
    const ciLog = [
      "2026-11-02T21:12:26.1234567Z @acme/backend:test:workspace: src/pool.test.ts:",
      "2026-11-02T21:12:26.1234567Z @acme/backend:test:workspace:       at x (/home/runner/work/acme/acme/apps/backend/src/pool.test.ts:3:1)",
      "2026-11-02T21:12:26.1234567Z \u001b[31m@acme/backend:test:workspace: (fail) idle connections expire [12.00ms]\u001b[0m",
      "2026-11-02T21:12:26.1234567Z @acme/backend:test:workspace:  1 fail",
    ].join("\n");
    writeFileSync(path.join(root, "ci.log"), ciLog);
    const gh = path.join(root, "fake-gh");
    writeFileSync(
      gh,
      [
        "#!/bin/sh",
        options.legacy ? 'if [ "$2" = "--allow-escape-sequences" ]; then exit 1; fi' : "",
        "for last; do :; done",
        'case "$last" in',
        `  */commits/${mergeBase}/check-runs*) printf '%s' '{"check_runs":[{"id":7,"name":"test","status":"completed","conclusion":"failure","app":{"slug":"github-actions"}}]}' ;;`,
        `  */actions/runs[?]*) printf '%s' '{"workflow_runs":[{"id":19}]}' ;;`,
        `  */actions/runs/19/jobs*) printf '%s' '{"jobs":[{"id":83,"check_run_url":"https://api.github.com/repos/acme/acme/check-runs/7"}]}' ;;`,
        `  */actions/jobs/83/logs) cat "${path.join(root, "ci.log")}" ;;`,
        "  *) exit 1 ;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(gh, 0o755);
    return gh;
  }

  for (const legacy of [false, true]) {
    test(`a test CI failed on the merge-base commit is unrelated${legacy ? " (older gh)" : ""}`, () => {
      const root = fixture(MODULES);
      const mergeBase = "a".repeat(40);
      const triage = classify(root, {
        output: bunAggregate(root),
        // Both tests import a changed file, so only CI can excuse one.
        changedFiles: ["apps/backend/src/pool.ts", "apps/backend/src/close.ts"],
        mergeBase,
        ci: { repository: "acme/acme", gh: fakeGh(root, mergeBase, { legacy }) },
      });
      const byFile = Object.fromEntries(failures(triage).map((f) => [f.file, f]));
      expect(byFile["apps/backend/src/pool.test.ts"]).toMatchObject({
        verdict: "unrelated",
        reasons: ["imports-changed-file", "failed-on-target-ci"],
      });
      expect(byFile["apps/backend/src/close.test.ts"]!.verdict).toBe("related");
      expect(triage.limitations).toEqual([]);
    });
  }

  test("CI is not consulted when every failure is already unrelated", () => {
    const root = fixture(MODULES);
    const gh = path.join(root, "fake-gh");
    // Fails loudly if called: a limitation would appear.
    writeFileSync(gh, "#!/bin/sh\nexit 1\n");
    chmodSync(gh, 0o755);
    const triage = classify(root, {
      output: bunAggregate(root),
      changedFiles: ["docs/notes.md"],
      mergeBase: "c".repeat(40),
      ci: { repository: "acme/acme", gh },
    });
    expect(failures(triage).every((f) => f.verdict === "unrelated")).toBe(true);
    expect(triage.limitations).toEqual([]);
  });

  test("an unreadable CI result is a limitation, not a failure", () => {
    const root = fixture(MODULES);
    const gh = path.join(root, "fake-gh");
    writeFileSync(gh, "#!/bin/sh\nexit 1\n");
    chmodSync(gh, 0o755);
    const triage = classify(root, {
      output: bunAggregate(root),
      changedFiles: ["apps/backend/src/pool.ts"],
      mergeBase: "b".repeat(40),
      ci: { repository: "acme/acme", gh },
    });
    expect(triage.limitations).toEqual([
      "The target branch's CI result for bbbbbbbbbbbb could not be read",
    ]);
  });
});

describe("conservative dependency attribution", () => {
  for (const changedPath of ["apps/backend/src/pool.test.ts", "apps/backend/src/pool.ts"]) {
    test(`registry membership cannot excuse ${changedPath}`, () => {
      const root = fixture({
        ...MODULES,
        "docs/tests/flaky-tests/backend/0000-index.md":
          "| Status | Test | File |\n| --- | --- | --- |\n| open | `idle connections expire` | apps/backend/src/pool.test.ts |",
      });
      const result = classify(root, { output: bunAggregate(root), changedFiles: [changedPath] });
      expect(failures(result).find((f) => f.name === "idle connections expire")).toMatchObject({
        verdict: "related",
        reasons: expect.arrayContaining(["known-flaky"]),
      });
    });
  }
  test("an open flake-registry row never changes a verdict", () => {
    const registry = [
      "| Status | Test | File |",
      "| --- | --- | --- |",
      "| open | `idle connections expire` | apps/backend/src/pool.test.ts |",
      "| open | `a capture's write finishes while a long sweep is still walking` | |",
    ].join("\n");
    const unknownTest =
      "a sweep's lock > a capture's write finishes while a long sweep is still walking";
    // The last failure names no file this tree has, as in to-do 4520's
    // `known-flaky`, `test-file-unknown` row.
    const output = (root: string) =>
      bunAggregate(root, 3).replace(
        "@acme/backend:test:workspace:  13339 pass",
        `@acme/backend:test:workspace: (fail) ${unknownTest}\n@acme/backend:test:workspace:  13339 pass`,
      );
    const verdicts = (changedFiles: string[], listed: boolean) => {
      const root = fixture({
        ...MODULES,
        ...(listed ? { "docs/tests/flaky-tests/backend/0000-index.md": registry } : {}),
      });
      const triage = classify(root, { output: output(root), changedFiles });
      expect(triage.commands[0]!.unattributed).toBe(false);
      return Object.fromEntries(failures(triage).map((f) => [f.name, f]));
    };
    for (const [changedFiles, poolVerdict] of [
      [["docs/notes.md"], "unrelated"],
      [["apps/backend/src/pool.ts"], "related"],
    ] as const) {
      const without = verdicts([...changedFiles], false);
      const withRow = verdicts([...changedFiles], true);
      expect(withRow["idle connections expire"]).toMatchObject({
        verdict: poolVerdict,
        reasons: expect.arrayContaining(["known-flaky"]),
      });
      expect(withRow[unknownTest]).toMatchObject({
        file: null,
        verdict: "undetermined",
        reasons: ["known-flaky", "test-file-unknown"],
      });
      for (const name of Object.keys(without)) {
        expect(withRow[name]!.verdict).toBe(without[name]!.verdict);
      }
    }
  });
  for (const source of [
    'const moduleName = "./runtime"; import(moduleName);',
    'const moduleName = "./runtime"; require(moduleName);',
    'import { spawnSync as launch } from "node:child_process"; launch("bun", ["runtime.ts"]);',
    'Bun.spawn(["bun", "runtime.ts"]);',
  ]) {
    test(`runtime boundary stays blocking: ${source}`, () => {
      const root = fixture({
        "src/a.test.ts":
          'import "./loader"; test("runtime works", () => {}); test("migration loads", () => {});',
        "src/loader.ts": source,
        "src/runtime.ts": "export {};",
      });
      const result = classify(root, {
        output: "src/a.test.ts:\n(fail) runtime works\n 1 fail",
        changedFiles: ["src/runtime.ts"],
      });
      expect(failures(result)[0]!.verdict).not.toBe("unrelated");
    });
  }
  test("production runtime file reads contribute dependency evidence", () => {
    const root = fixture({
      "src/a.test.ts":
        'import "./loader"; test("runtime works", () => {}); test("migration loads", () => {});',
      "src/loader.ts":
        'import { readFileSync } from "node:fs"; readFileSync("migrations/initial.sql");',
      "migrations/initial.sql": "SELECT 1;",
    });
    const result = classify(root, {
      output: "src/a.test.ts:\n(fail) migration loads\n 1 fail",
      changedFiles: ["migrations/initial.sql"],
    });
    expect(failures(result)[0]!.verdict).toBe("related");
    const unknown = classify(root, {
      output: "src/a.test.ts:\n(fail) migration loads\n 1 fail",
      changedFiles: ["migrations/other.sql"],
    });
    expect(failures(unknown)[0]!.verdict).toBe("undetermined");
  });
  test("missing artifacts retain incomplete commands beside unrelated failures", () => {
    const root = fixture(MODULES);
    writeFileSync(path.join(root, "out.txt"), bunAggregate(root));
    const result = classify(root, {
      commands: [
        { command: "test", cwd: ".", status: "failed", stdoutPath: "out.txt", stderrPath: null },
        {
          command: "never started",
          cwd: ".",
          status: "incomplete",
          stdoutPath: null,
          stderrPath: null,
        },
      ],
    });
    expect(result.commands[0]!.failures.every((f) => f.verdict === "unrelated")).toBe(true);
    expect(result.commands[1]).toMatchObject({ failures: [], unattributed: true });
  });
});
