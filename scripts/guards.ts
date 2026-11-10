/**
 * The guard stage: the repository-wide guards, in one process, in seconds.
 *
 *   mise run guards                   # every guard
 *   mise run guards -- --only dom-absence --only source-guards
 *
 * Each guard used to be a unit test that walked, read and parsed the
 * repository on its own, a dozen walks per run, and they were the suite's most
 * frequent failures, reported only when a 10-30 minute run ended. Here they
 * share one listing (`git ls-files -co --exclude-standard`), one read per file
 * and, for the source guards, one parse per file. `mise run test` runs this
 * stage first and stops before admitting any test group when it fails
 * (`ORKESTRATOR_TEST_SKIP_GUARDS=1` skips it); `mise run check` runs it
 * between lint and typecheck.
 *
 * The guards' own fixture tests stay in the unit suite; each check of the real
 * repository runs only here. The documentation register checks are ordinary
 * Bun test files, so this stage runs them as one `bun test` child alongside
 * the in-process guards, and the aggregate runner leaves them out of its root
 * group once this stage has passed.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseSync } from "oxc-parser";
import { scanDomAbsenceAssertions } from "../tests/dom-absence-scan";
import {
  BASELINE_PATH,
  compareWithBaseline,
  formatRegressions,
  formatStale,
  parseBaseline,
  serializeBaseline,
} from "../tests/source-guards/baseline";
import type { GuardId, SourceGuard } from "../tests/source-guards/guard";
import { checkInheritanceChains, findChains } from "../tests/source-guards/inheritance-chains";
import { createLibBackendCommandDefaultGuard } from "../tests/source-guards/lib-backend-command-default";
import { RAW_WEBREQUEST_LISTENER_ROOTS } from "../tests/source-guards/raw-webrequest-listener";
import { checkRawConsole } from "../tests/source-guards/raw-console";
import { RepositoryIndex } from "../tests/source-guards/repository-index";
import { SOURCE_GUARDS, listProductionSources, scanRepository } from "../tests/source-guards/scan";
import { OwnershipModel } from "../tests/source-guards/test-suite-ownership";
import { GUARD_STAGE_TEST_FILES } from "./test-all";
import { indexedModules } from "../tests/source-guards/web-modules";
import {
  WINDOW_ORKESTRATOR_ROOTS,
  transportAccesses,
  windowOrkestratorDirect,
} from "../tests/source-guards/window-orkestrator-direct";
import {
  WORKSPACE_EXEMPT_MODULES,
  WORKSPACE_ROOT_MODULES,
  createWorkspaceCommandBoundCallGuard,
  workspaceGraph,
} from "../tests/source-guards/workspace-command-bound-call";

const repositoryRoot = path.resolve(import.meta.dir, "..");

/** The longest the register tests may take before the stage gives up on them. */
const REGISTER_TESTS_TIMEOUT_MS = 120_000;

export interface GuardContext {
  root: string;
  index: RepositoryIndex;
}

export interface RepositoryGuard {
  id: string;
  /** What the guard holds, one line. */
  description: string;
  /** What to do about a failure; printed under its problems. */
  advice: string;
  /** Every problem as one line (or a preformatted block); empty when the guard passes. */
  run(context: GuardContext): string[] | Promise<string[]>;
}

/** The ratchet over every source guard, plus the checks that the scan reaches what it should. */
function sourceGuardProblems({ index }: GuardContext): string[] {
  const readModule = indexedModules(index);
  const graph = workspaceGraph(readModule);
  const guards: SourceGuard[] = SOURCE_GUARDS.map((guard) =>
    guard.id === "workspace-command-bound-call"
      ? createWorkspaceCommandBoundCallGuard({ readModule, graph })
      : guard.id === "lib-backend-command-default"
        ? createLibBackendCommandDefaultGuard({ readModule })
        : guard,
  );
  const findings = scanRepository(index, guards);
  const baselineText = readFileSync(BASELINE_PATH, "utf8");
  const { regressions, stale } = compareWithBaseline(findings, parseBaseline(baselineText));
  const advice = Object.fromEntries(guards.map((guard) => [guard.id, guard.advice])) as Record<
    GuardId,
    string
  >;
  const problems = [formatRegressions(regressions, advice), formatStale(stale)].filter(Boolean);
  if (serializeBaseline(parseBaseline(baselineText)) !== baselineText)
    problems.push(
      "tests/source-guards/baseline.json is not in the form the regenerate command writes; " +
        "regenerate it with `bun tests/source-guards/update-baseline.ts --guard <id>`.",
    );

  // The production-source guards must read production sources only, and must
  // reach the files they exist for; an empty finding list could mean either.
  for (const id of ["window-orkestrator-direct", "direct-transport-import"] as const) {
    const files = Object.keys(findings[id]);
    if (files.length === 0) problems.push(`${id} found nothing: the scan no longer reaches it`);
    for (const file of files.filter((candidate) => /\.(?:test|spec)\./.test(candidate)))
      problems.push(`${id} read a test file: ${file}`);
  }
  const listeners = listProductionSources(index, RAW_WEBREQUEST_LISTENER_ROOTS).filter((file) =>
    /webRequest\.on[A-Z]/.test(index.read(file) ?? ""),
  );
  for (const expected of [
    "apps/desktop/electron/artifact-host-session.ts",
    "apps/desktop/electron/preview-transport-manager.ts",
    "apps/desktop/electron/renderer-file-policy.ts",
  ])
    if (!listeners.includes(expected))
      problems.push(`raw-webrequest-listener no longer reaches ${expected}`);
  // Without exemptions, so an exemption must name a module the workspace really reaches.
  const unexempted = workspaceGraph(readModule, WORKSPACE_ROOT_MODULES, {});
  for (const root of WORKSPACE_ROOT_MODULES)
    if (!unexempted.has(root)) problems.push(`the workspace graph lost its root ${root}`);
  for (const reached of [
    "apps/web/src/components/terminal/TerminalContainer",
    "apps/web/src/components/projects/ProjectWorkspace",
  ])
    if (!unexempted.has(reached)) problems.push(`the workspace graph no longer reaches ${reached}`);
  for (const [moduleId, reason] of Object.entries(WORKSPACE_EXEMPT_MODULES)) {
    if (!unexempted.has(moduleId))
      problems.push(
        `WORKSPACE_EXEMPT_MODULES names ${moduleId}, which the workspace no longer reaches`,
      );
    if (reason.length <= 10) problems.push(`WORKSPACE_EXEMPT_MODULES gives ${moduleId} no reason`);
  }

  // The transport members of window.orkestrator have no baseline at all.
  for (const file of listProductionSources(index, WINDOW_ORKESTRATOR_ROOTS)) {
    if (!windowOrkestratorDirect.appliesTo({ path: file, source: "", isBunTest: false })) continue;
    const source = index.read(file);
    if (source === null || !windowOrkestratorDirect.mayOffend(source)) continue;
    const { program } = parseSync(file, source, { astType: "js" });
    for (const offset of transportAccesses(program as never))
      problems.push(
        `${file}:${source.slice(0, offset).split("\n").length} reads a transport member off window.orkestrator; use the node scope's client`,
      );
  }
  return problems;
}

export const REPOSITORY_GUARDS: readonly RepositoryGuard[] = [
  {
    id: "source-guards",
    description: "Source guards (tests/source-guards/) against their shrink-only baseline",
    advice:
      "Fix new findings; never raise the baseline to hide one. Each guard's advice is above; " +
      "the guards are described in docs/development/linting.md (Source guards).",
    run: sourceGuardProblems,
  },
  {
    id: "dom-absence",
    description: "No DOM-producing query result passed straight to toBeNull",
    advice:
      "Bun prints the received node in full when toBeNull fails. Rewrite each assertion as " +
      "`expect(x === null).toBe(true)`: `bun scripts/rewrite-bounded-dom-assertions.ts` does it " +
      "(docs/development/linting.md).",
    run: ({ index }) =>
      scanDomAbsenceAssertions(index).map(
        (file) => `${file} passes a DOM query result to toBeNull`,
      ),
  },
  {
    id: "inheritance-chains",
    description: "No project-class inheritance outside the recorded sets",
    advice:
      "Split a large class by responsibility into collaborators, not into `extends` layers " +
      '("Splitting large classes" in AGENTS.md). A deliberate one-level subclass goes in ' +
      "INTENTIONAL_SUBCLASSES in tests/source-guards/inheritance-chains.ts with its reason; " +
      "remove an entry whose chain is gone.",
    run: ({ index }) => checkInheritanceChains(findChains(index)),
  },
  {
    id: "test-suite-ownership",
    description: "Every test file runs in exactly one default suite or has an explicit owner",
    advice:
      "Add an unowned file to the suite that should run it: ROOT_TEST_PATHS in " +
      "scripts/test-all.ts for a root or e2e support test, the package's `test:workspace` or " +
      "the bridge's `test:bridge` script, or an explicit owner in " +
      "tests/source-guards/test-suite-ownership.ts (docs/development/testing-guide.md).",
    run: ({ index }) => new OwnershipModel(index).check(),
  },
  {
    id: "raw-console",
    description: "No directive disables the console lint rule, and the rule reaches every app",
    advice:
      "Use createLogger from @orkestrator/protocol/logger; do not disable no-restricted-globals. " +
      "The permanent exclusions live in tests/source-guards/raw-console.ts and .oxlintrc.json " +
      '(docs/development/linting.md, "Raw `console`").',
    run: ({ index }) => checkRawConsole(index),
  },
];

interface GuardOutcome {
  id: string;
  problems: string[];
  advice: string;
}

/** Runs the documentation register test files as one Bun child, bounded by a deadline. */
function runRegisterTests(root: string): Promise<GuardOutcome> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "test",
        ...GUARD_STAGE_TEST_FILES.map((file) => `./${file}`),
        `--parallel=${GUARD_STAGE_TEST_FILES.length}`,
        "--only-failures",
      ],
      { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const append = (chunk: Buffer) => {
      // Bounded: a passing run prints a few lines, a failing one its reports.
      output = (output + chunk.toString("utf8")).slice(-64 * 1024);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, REGISTER_TESTS_TIMEOUT_MS);
    const finish = (status: number | null, error?: Error) => {
      clearTimeout(deadline);
      const failed = status !== 0 || error !== undefined;
      resolve({
        id: "doc-registers",
        problems: failed
          ? [
              timedOut
                ? `bun test did not finish within ${REGISTER_TESTS_TIMEOUT_MS} ms`
                : (error?.message ?? output.trim()),
            ]
          : [],
        advice:
          "The flaky-test, to-do and number-claim registers (docs/tests/flaky-tests, docs/todo, " +
          "docs/number-claims): fix the index rows or renumber as the failure says. Rerun alone with " +
          `\`bun test ${GUARD_STAGE_TEST_FILES.map((file) => `./${file}`).join(" ")} --parallel=1\`.`,
      });
    };
    child.once("error", (error) => finish(null, error));
    child.once("close", (status) => finish(status));
  });
}

function parseOnly(argv: readonly string[]): Set<string> | null {
  const known = new Set([...REPOSITORY_GUARDS.map((guard) => guard.id), "doc-registers"]);
  const only = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] === "--only" ? argv[++index] : undefined;
    if (!value || !known.has(value))
      throw new Error(`usage: guards.ts [--only <${[...known].join("|")}>]...`);
    only.add(value);
  }
  return only.size > 0 ? only : null;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export async function runGuards(
  options: {
    root?: string;
    guards?: readonly RepositoryGuard[];
    /** `false` leaves out the register test files (the guard's own tests use fakes). */
    registerTests?: boolean;
    log?: (line: string) => void;
  } = {},
): Promise<number> {
  const root = options.root ?? repositoryRoot;
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const startedAt = performance.now();
  // Started first: the child runs while this process scans.
  const registers = options.registerTests === false ? undefined : runRegisterTests(root);
  const index = RepositoryIndex.fromGit(root);
  const outcomes: GuardOutcome[] = [];
  for (const guard of options.guards ?? REPOSITORY_GUARDS) {
    const guardStartedAt = performance.now();
    let problems: string[];
    try {
      problems = await guard.run({ root, index });
    } catch (error) {
      // A guard that cannot run (a file that does not parse, say) fails; it never passes.
      problems = [`the guard threw: ${error instanceof Error ? error.message : String(error)}`];
    }
    outcomes.push({ id: guard.id, problems, advice: guard.advice });
    log(
      `${problems.length === 0 ? "PASS" : "FAIL"} ${guard.id} (${formatMs(performance.now() - guardStartedAt)})`,
    );
  }
  if (registers) {
    const outcome = await registers;
    outcomes.push(outcome);
    // The child ran alongside the scans, and its exit is only seen once they
    // finish, so its own wall time is not measurable here.
    log(`${outcome.problems.length === 0 ? "PASS" : "FAIL"} ${outcome.id} (bun test, alongside)`);
  }

  const failed = outcomes.filter((outcome) => outcome.problems.length > 0);
  for (const outcome of failed) {
    log(`\n=== ${outcome.id}: ${outcome.problems.length} problem(s) ===`);
    for (const problem of outcome.problems) log(problem);
    log(`\nWhat to do: ${outcome.advice}`);
  }
  const elapsed = formatMs(performance.now() - startedAt);
  if (failed.length > 0) {
    log(
      `\nGuards failed: ${failed.map((outcome) => outcome.id).join(", ")} (${elapsed}). ` +
        "Rerun with `mise run guards`.",
    );
    return 1;
  }
  log(`\nAll ${outcomes.length} guards passed (${elapsed}).`);
  return 0;
}

if (import.meta.main) {
  let only: Set<string> | null;
  try {
    only = parseOnly(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  process.exitCode = await runGuards({
    guards: only ? REPOSITORY_GUARDS.filter((guard) => only.has(guard.id)) : REPOSITORY_GUARDS,
    registerTests: !only || only.has("doc-registers"),
  });
}
