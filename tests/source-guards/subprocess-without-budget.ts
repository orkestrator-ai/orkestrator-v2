import {
  chainRoot,
  isFunction,
  isMember,
  isTypeOnlyImport,
  memberName,
  unwrap,
  type AnyNode,
} from "./ast";
import type { GuardVisitor, NodeHandlers, SourceGuard } from "./guard";

const CHILD_PROCESS_MODULES: ReadonlySet<string> = new Set(["node:child_process", "child_process"]);

const CHILD_PROCESS_FUNCTIONS: ReadonlySet<string> = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);

/** Imported helpers that obviously run Git: `git`, `runGit`, `gitSync`, `initGitRepo`, … */
const GIT_HELPER =
  /^(?:git(?:Sync|Command|Output|Exec|Run|Ok)?|(?:run|exec|real|spawn|call)Git\w*|(?:init|create|make|setup|seed)Git(?:Repo|Repository|Worktree|Project)\w*)$/;

const TEST_FUNCTIONS: ReadonlySet<string> = new Set(["test", "it"]);
const HOOK_FUNCTIONS: ReadonlySet<string> = new Set([
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
]);

/** Whether a test or hook call passes anything after its callback (a timeout or options). */
function hasExplicitBudget(call: AnyNode): boolean {
  const root = chainRoot(call.callee);
  if (root.type !== "Identifier") return false;
  if (!TEST_FUNCTIONS.has(root.name) && !HOOK_FUNCTIONS.has(root.name)) return false;
  const args: AnyNode[] = call.arguments;
  const callbackIndex = args.findIndex((argument) => isFunction(unwrap(argument)));
  if (callbackIndex < 0) return false;
  const budget = args[callbackIndex + 1];
  return !!budget && !(unwrap(budget).type === "Identifier" && unwrap(budget).name === "undefined");
}

function isBudgetCall(call: AnyNode): boolean {
  const callee = unwrap(call.callee);
  return (
    (callee.type === "Identifier" && callee.name === "setDefaultTimeout") ||
    memberName(callee) === "setDefaultTimeout" ||
    hasExplicitBudget(call)
  );
}

/**
 * Reports the first place a file starts a real process, when the file sets
 * no time budget anywhere.
 */
function visitSubprocesses(program: AnyNode, source: string): GuardVisitor {
  const childProcessLocals = new Set<string>();
  const childProcessNamespaces = new Set<string>();
  const bunShellLocals = new Set<string>();
  const gitHelperLocals = new Set<string>();
  /** Spans of import declarations, whose identifiers are names, not uses. */
  const importSpans: Array<[number, number]> = [];
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    importSpans.push([statement.start, statement.end]);
    if (isTypeOnlyImport(statement, source)) continue;
    const from = statement.source.value;
    for (const specifier of statement.specifiers) {
      if (isTypeOnlyImport(specifier, source)) continue;
      const imported =
        specifier.type === "ImportSpecifier"
          ? (specifier.imported.name ?? specifier.imported.value)
          : undefined;
      if (CHILD_PROCESS_MODULES.has(from)) {
        if (imported === undefined) childProcessNamespaces.add(specifier.local.name);
        else if (CHILD_PROCESS_FUNCTIONS.has(imported))
          childProcessLocals.add(specifier.local.name);
      } else if (from === "bun" && imported === "$") {
        bunShellLocals.add(specifier.local.name);
      } else if (imported !== undefined && GIT_HELPER.test(specifier.local.name)) {
        gitHelperLocals.add(specifier.local.name);
      }
    }
  }
  let first: number | undefined;
  let budgeted = false;
  const found = (offset: number): void => {
    if (first === undefined || offset < first) first = offset;
  };
  const handlers: NodeHandlers = {
    CallExpression(node) {
      if (!budgeted && isBudgetCall(node)) budgeted = true;
      const callee = unwrap(node.callee);
      if (isMember(callee, "Bun", "spawn") || isMember(callee, "Bun", "spawnSync"))
        found(node.start);
      else if (
        callee.type === "MemberExpression" &&
        unwrap(callee.object).type === "Identifier" &&
        childProcessNamespaces.has(unwrap(callee.object).name) &&
        CHILD_PROCESS_FUNCTIONS.has(memberName(callee) ?? "")
      )
        found(node.start);
      else if (callee.type === "Identifier" && gitHelperLocals.has(callee.name)) found(node.start);
    },
    TaggedTemplateExpression(node) {
      const root = chainRoot(node.tag);
      if (
        isMember(node.tag, "Bun", "$") ||
        (root.type === "Identifier" && bunShellLocals.has(root.name))
      )
        found(node.start);
    },
  };
  // Identifiers are the commonest node; only watch them when there is a name to watch for.
  if (childProcessLocals.size > 0)
    handlers.Identifier = (node) => {
      // Called directly or handed to `promisify`: either way the file runs it.
      if (
        childProcessLocals.has(node.name) &&
        !importSpans.some(([start, end]) => node.start >= start && node.end <= end)
      )
        found(node.start);
    };
  return {
    handlers,
    finish: () => (first === undefined || budgeted ? [] : [first]),
  };
}

export const subprocessWithoutBudget: SourceGuard = {
  id: "subprocess-without-budget",
  advice:
    "This test file starts real processes but sets no time budget, so Bun's 5 s default " +
    "applies; under aggregate load it kills real subprocess work, which shows up as " +
    "`exitCode: null` and 'killed'. First check there is no real race to fix, then give the " +
    "file setDefaultTimeout(30_000) (imported from bun:test) registered before its hooks, or " +
    "per-test budgets.",
  appliesTo: (file) => file.isBunTest,
  // A file that names setDefaultTimeout is taken as budgeted without parsing; a
  // commented-out call is the accepted miss.
  mayOffend: (source) =>
    /Bun\.(?:spawn|\$)|child_process|\$`|\bimport\b[^;]*?\b(?:git|\w*Git)\w*\b[^;]*?\bfrom\b/.test(
      source,
    ) && !source.includes("setDefaultTimeout("),
  visit: (program, file) => visitSubprocesses(program, file.source),
};
