import { parseSync, Visitor, type VisitorObject } from "oxc-parser";
import type { AnyNode } from "./ast";
import { directTransportImport } from "./direct-transport-import";
import {
  GUARD_IDS,
  type GuardId,
  type NodeHandlers,
  type ScannedFile,
  type SourceGuard,
} from "./guard";
import { isTestSource } from "./paths";
import { underDirectoryNamed, type SourceIndex } from "./repository-index";
import { libBackendCommandDefault } from "./lib-backend-command-default";
import { rawWebRequestListener } from "./raw-webrequest-listener";
import { releasedPortRebind } from "./released-port-rebind";
import { sleepBeforeNegativeAssertion } from "./sleep-before-negative-assertion";
import { smallFakePid } from "./small-fake-pid";
import { subprocessWithoutBudget } from "./subprocess-without-budget";
import { windowOrkestratorDirect } from "./window-orkestrator-direct";
import { windowOrkestratorPortal } from "./window-orkestrator-portal";
import { workspaceCommandBoundCall } from "./workspace-command-bound-call";

export const SOURCE_GUARDS: readonly SourceGuard[] = [
  sleepBeforeNegativeAssertion,
  releasedPortRebind,
  subprocessWithoutBudget,
  smallFakePid,
  windowOrkestratorDirect,
  directTransportImport,
  libBackendCommandDefault,
  windowOrkestratorPortal,
  workspaceCommandBoundCall,
  rawWebRequestListener,
];

export const SCANNED_ROOTS = ["tests", "apps", "bridges", "packages", "scripts", "e2e"] as const;

/**
 * Dependencies and generated copies are not repository test sources, and
 * installed dependencies must not determine the scan cost.
 */
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", "dist", ".git"]);

/** The guards' own fixture snippets, which offend on purpose. */
const EXCLUDED_PATHS: ReadonlySet<string> = new Set(["tests/source-guards/fixtures"]);

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const BUN_TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

export { isTestSource };

export interface Finding {
  guard: GuardId;
  file: string;
  line: number;
  /** Set by guards that count per subject (see `SubjectFinding`). */
  subject?: string;
}

/**
 * The baseline entry a finding counts against: its file, or
 * `[subject] file` for a guard that counts per subject.
 */
export function baselineKey(finding: Pick<Finding, "file" | "subject">): string {
  return finding.subject ? `[${finding.subject}] ${finding.file}` : finding.file;
}

/** Per guard, findings grouped by baseline key (`baselineKey`). */
export type Findings = Record<GuardId, Record<string, Finding[]>>;

export function emptyFindings(): Findings {
  return Object.fromEntries(GUARD_IDS.map((id) => [id, {}])) as Findings;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = source.indexOf("\n"); index !== -1 && index < offset;) {
    line += 1;
    index = source.indexOf("\n", index + 1);
  }
  return line;
}

/** One handler per node type, calling each guard that registered one. */
function mergeHandlers(all: readonly NodeHandlers[]): NodeHandlers {
  const merged: NodeHandlers = {};
  for (const handlers of all) {
    for (const [type, handler] of Object.entries(handlers)) {
      const previous = merged[type];
      merged[type] = previous
        ? (node) => {
            previous(node);
            handler(node);
          }
        : handler;
    }
  }
  return merged;
}

/** Runs every applicable guard over one file, parsing it at most once. */
export function scanSource(
  file: ScannedFile,
  guards: readonly SourceGuard[] = SOURCE_GUARDS,
): Finding[] {
  const candidates = guards.filter(
    (guard) => guard.appliesTo(file) && guard.mayOffend(file.source),
  );
  if (candidates.length === 0) return [];
  // The guards read no type annotations; the JS-shaped AST is about a quarter
  // cheaper to deserialize, and deserializing is most of the scan's cost.
  const { program, errors } = parseSync(file.path, file.source, {
    preserveParens: false,
    astType: "js",
  });
  // A file that does not parse must not pass by yielding a partial tree.
  if (errors.length > 0) throw new Error(`${file.path}: ${errors[0]!.message}`);
  const root = program as unknown as AnyNode;
  const visitors = candidates.map((guard) => guard.visit(root, file));
  new Visitor(mergeHandlers(visitors.map((visitor) => visitor.handlers)) as VisitorObject).visit(
    program,
  );
  const findings: Finding[] = [];
  candidates.forEach((guard, index) => {
    for (const found of visitors[index]!.finish()) {
      const offset = typeof found === "number" ? found : found.offset;
      const finding: Finding = {
        guard: guard.id,
        file: file.path,
        line: lineAt(file.source, offset),
      };
      if (typeof found !== "number") finding.subject = found.subject;
      findings.push(finding);
    }
  });
  return findings;
}

/** Whether a listed file is one of the test sources the test-source guards read. */
function isScannedTestSource(relative: string): boolean {
  return (
    SCANNED_ROOTS.some((sourceRoot) => relative.startsWith(`${sourceRoot}/`)) &&
    !underDirectoryNamed(relative, EXCLUDED_DIRECTORIES) &&
    ![...EXCLUDED_PATHS].some((excluded) => relative.startsWith(`${excluded}/`)) &&
    isTestSource(relative)
  );
}

/** Every test source under the scanned roots, repository-relative and sorted. */
export function listTestSources(index: SourceIndex): string[] {
  return index.files.filter(isScannedTestSource).sort();
}

/**
 * Production sources under `roots`: script files that are neither test
 * sources nor declarations, repository-relative and sorted.
 */
export function listProductionSources(index: SourceIndex, roots: readonly string[]): string[] {
  const unique = [...new Set(roots)];
  return index.files
    .filter(
      (relative) =>
        unique.some((sourceRoot) => relative.startsWith(`${sourceRoot}/`)) &&
        !underDirectoryNamed(relative, EXCLUDED_DIRECTORIES) &&
        SCRIPT_FILE.test(relative) &&
        !relative.endsWith(".d.ts") &&
        !isTestSource(relative),
    )
    .sort();
}

/**
 * Lists the repository's test sources once and runs every test-source guard
 * over them, then the production sources of guards that read those instead.
 * Each file is read once (through `index`) and parsed at most once.
 */
export function scanRepository(
  index: SourceIndex,
  guards: readonly SourceGuard[] = SOURCE_GUARDS,
): Findings {
  const findings = emptyFindings();
  const scanFile = (relative: string, fileGuards: readonly SourceGuard[]) => {
    if (fileGuards.length === 0) return;
    const source = index.read(relative);
    // Deleted from the working tree, or a symbolic link: nothing to scan.
    if (source === null) return;
    const file: ScannedFile = {
      path: relative,
      source,
      isBunTest: BUN_TEST_FILE.test(relative),
      readSource: (other) => index.read(other),
    };
    for (const finding of scanSource(file, fileGuards))
      (findings[finding.guard][baselineKey(finding)] ??= []).push(finding);
  };
  const testGuards = guards.filter((guard) => !guard.productionRoots);
  if (testGuards.length > 0)
    for (const relative of listTestSources(index)) scanFile(relative, testGuards);
  const productionGuards = guards.filter((guard) => guard.productionRoots);
  const roots = productionGuards.flatMap((guard) => guard.productionRoots ?? []);
  for (const relative of listProductionSources(index, roots)) {
    const under = (sourceRoot: string) => relative.startsWith(`${sourceRoot}/`);
    scanFile(
      relative,
      productionGuards.filter((guard) => guard.productionRoots?.some(under)),
    );
  }
  return findings;
}
