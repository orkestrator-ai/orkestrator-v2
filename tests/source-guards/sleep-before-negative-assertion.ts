import {
  contains,
  containsOutsideFunctions,
  functionStatements,
  isFunction,
  isMember,
  memberName,
  numericValue,
  parameterNames,
  unwrap,
  type AnyNode,
} from "./ast";
import path from "node:path";
import { parseSync } from "oxc-parser";
import type { GuardVisitor, ScannedFile, SourceGuard } from "./guard";
import { isTestSource } from "./paths";

/** Imported or global helpers assumed to sleep for their first argument in milliseconds. */
const SLEEP_NAMES: ReadonlySet<string> = new Set([
  "sleep",
  "delay",
  "wait",
  "pause",
  "sleepMs",
  "waitMs",
  "delayMs",
]);

/**
 * Matchers that pass when something did not happen, or happened an exact
 * number of times. After a fixed sleep they only prove the sleep was shorter
 * than the work, which a loaded host does not guarantee.
 */
const ALWAYS_NEGATIVE_MATCHERS: ReadonlySet<string> = new Set([
  "toBeUndefined",
  "toBeNull",
  "toBeFalsy",
  "toHaveBeenCalledTimes",
  "toBeCalledTimes",
]);

/** A local helper's sleep: either a fixed delay, or one taken from its arguments. */
type LocalSleep = "fixed" | "argument";

interface Context {
  helpers: Map<string, LocalSleep>;
  /** Names in {@link SLEEP_NAMES} the file declares as something other than a sleep. */
  shadowed: Set<string>;
}

function isSetTimeout(callee: AnyNode): boolean {
  const target = unwrap(callee);
  return (
    (target.type === "Identifier" && target.name === "setTimeout") ||
    isMember(target, "globalThis", "setTimeout") ||
    isMember(target, "window", "setTimeout")
  );
}

/** The single expression a function evaluates, if its body is one expression or statement. */
function soleExpression(fn: AnyNode): AnyNode | undefined {
  const statements = functionStatements(fn);
  if (statements.length !== 1) return undefined;
  const statement = statements[0]!;
  if (statement.type === "ExpressionStatement") return statement.expression;
  if (statement.type === "ReturnStatement" && statement.argument) return statement.argument;
  return undefined;
}

/**
 * The delay a sleep expression waits for: the delay node itself, or `"fixed"`
 * for a call to a local helper whose own delay is a literal. `undefined` when
 * the expression is not a wall-clock sleep.
 */
function sleepDelay(expression: AnyNode, context: Context): AnyNode | "fixed" | undefined {
  let target = unwrap(expression);
  if (target.type === "AwaitExpression") target = unwrap(target.argument);
  if (target.type === "NewExpression") {
    const executor = target.arguments[0];
    if (unwrap(target.callee).type !== "Identifier" || unwrap(target.callee).name !== "Promise")
      return undefined;
    if (!isFunction(executor)) return undefined;
    const inner = soleExpression(executor);
    if (!inner || unwrap(inner).type !== "CallExpression") return undefined;
    const timer = unwrap(inner);
    return isSetTimeout(timer.callee) && timer.arguments.length >= 2
      ? timer.arguments[1]
      : undefined;
  }
  if (target.type !== "CallExpression") return undefined;
  const callee = unwrap(target.callee);
  const first = target.arguments[0];
  if (isMember(callee, "Bun", "sleep")) return first;
  if (memberName(callee) === "waitForTimeout") return first;
  // `setTimeout(ms)` from `node:timers/promises`: the callback form takes a function first.
  if (isSetTimeout(callee)) return first && !isFunction(first) ? first : undefined;
  if (callee.type !== "Identifier") return undefined;
  if (callee.name === "act") {
    const inner = isFunction(first) ? soleExpression(first) : undefined;
    return inner ? sleepDelay(inner, context) : undefined;
  }
  const helper = context.helpers.get(callee.name);
  if (helper === "fixed") return "fixed";
  if (helper === "argument")
    return target.arguments.find((argument: AnyNode) => (numericValue(argument) ?? 0) > 0) ?? first;
  if (SLEEP_NAMES.has(callee.name) && !context.shadowed.has(callee.name)) return first;
  return undefined;
}

function isFixedSleep(expression: AnyNode, context: Context): boolean {
  const delay = sleepDelay(expression, context);
  if (delay === undefined) return false;
  if (delay === "fixed") return true;
  return (numericValue(delay) ?? 0) > 0;
}

function referencesAny(node: AnyNode, names: ReadonlySet<string>): boolean {
  return contains(
    node,
    (candidate) => candidate.type === "Identifier" && names.has(candidate.name),
  );
}

interface Definition {
  name: string;
  fn: AnyNode;
}

/** Local functions whose whole body is a sleep, and the names that shadow a known sleep. */
function buildContext(definitions: readonly Definition[], declared: ReadonlySet<string>): Context {
  const context: Context = { helpers: new Map(), shadowed: new Set() };
  // A helper can be written in terms of another; three rounds cover any real nesting.
  for (let round = 0; round < 3; round += 1) {
    for (const { name, fn } of definitions) {
      if (context.helpers.has(name)) continue;
      const body = soleExpression(fn);
      const delay = body ? sleepDelay(body, context) : undefined;
      if (delay === undefined) continue;
      if (delay === "fixed" || (numericValue(delay) ?? 0) > 0) context.helpers.set(name, "fixed");
      else if (referencesAny(delay, parameterNames(fn))) context.helpers.set(name, "argument");
    }
  }
  for (const name of declared)
    if (SLEEP_NAMES.has(name) && !context.helpers.has(name)) context.shadowed.add(name);
  return context;
}

/** An `expect(...)...<matcher>(...)` statement, taken apart. */
interface Assertion {
  call: AnyNode;
  matcher: string;
  /** The statement is `await expect(...)`: a retrying (web-first) or promise assertion. */
  awaited: boolean;
  /** Every modifier between `expect(...)` and the matcher, such as `not` or `resolves`. */
  modifiers: Set<string>;
}

function assertionOf(statement: AnyNode): Assertion | undefined {
  if (statement.type !== "ExpressionStatement") return undefined;
  let call = unwrap(statement.expression);
  const awaited = call.type === "AwaitExpression";
  if (awaited) call = unwrap(call.argument);
  if (call.type !== "CallExpression") return undefined;
  const callee = unwrap(call.callee);
  const matcher = memberName(callee);
  if (!matcher || callee.type !== "MemberExpression") return undefined;
  const modifiers = new Set<string>();
  let receiver = unwrap(callee.object);
  while (receiver.type === "MemberExpression") {
    const name = memberName(receiver);
    if (name) modifiers.add(name);
    receiver = unwrap(receiver.object);
  }
  if (receiver.type !== "CallExpression") return undefined;
  const expectCallee = unwrap(receiver.callee);
  const isExpect =
    (expectCallee.type === "Identifier" && expectCallee.name === "expect") ||
    (expectCallee.type === "MemberExpression" &&
      unwrap(expectCallee.object).type === "Identifier" &&
      unwrap(expectCallee.object).name === "expect");
  return isExpect ? { call, matcher, awaited, modifiers } : undefined;
}

/** Whether a statement is `expect(...)...<matcher>(...)` with a negative or exact-count matcher. */
export function isNegativeAssertion(statement: AnyNode): boolean {
  const assertion = assertionOf(statement);
  if (!assertion) return false;
  const { call, matcher } = assertion;
  if (assertion.modifiers.has("not") || ALWAYS_NEGATIVE_MATCHERS.has(matcher)) return true;
  const expected = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  if (!expected) return false;
  if (matcher === "toBe")
    return expected.type === "Literal" && (expected.value === 0 || expected.value === false);
  if (matcher === "toHaveLength") return numericValue(expected) === 0;
  if (matcher === "toEqual" || matcher === "toStrictEqual")
    return expected.type === "ArrayExpression" && expected.elements.length === 0;
  return false;
}

/**
 * Whether a statement is a synchronous `expect(...)` assertion that something
 * did happen: not negative (see {@link isNegativeAssertion}), not awaited and
 * not on a promise. An awaited assertion waits for its own condition (a
 * Playwright web-first assertion retries; `.resolves` waits for the promise),
 * so the sleep before it is not what makes it pass.
 */
export function isPositiveAssertion(statement: AnyNode): boolean {
  const assertion = assertionOf(statement);
  if (!assertion || assertion.awaited) return false;
  if (assertion.modifiers.has("resolves") || assertion.modifiers.has("rejects")) return false;
  return !isNegativeAssertion(statement);
}

/**
 * A fixed sleep and the assertions that follow it before any other await:
 * what the sleep is standing in for a signal to.
 */
export interface SleepWindow {
  /** Source offset of the sleep statement. */
  offset: number;
  negative: boolean;
  positive: boolean;
}

/** Each fixed sleep in `statements` that at least one assertion follows before any other await. */
function sleepWindows(statements: readonly AnyNode[], context: Context): SleepWindow[] {
  const windows: SleepWindow[] = [];
  let open: SleepWindow | undefined;
  const close = () => {
    if (open && (open.negative || open.positive)) windows.push(open);
    open = undefined;
  };
  for (const statement of statements) {
    if (
      statement.type === "ExpressionStatement" &&
      unwrap(statement.expression).type === "AwaitExpression" &&
      isFixedSleep(statement.expression, context)
    ) {
      close();
      open = { offset: statement.start, negative: false, positive: false };
      continue;
    }
    if (!open) continue;
    if (isNegativeAssertion(statement)) {
      open.negative = true;
      continue;
    }
    // An await anywhere else (including `expect(await read())`) waits on
    // something real, so the sleep no longer stands alone before what follows.
    if (containsOutsideFunctions(statement, (candidate) => candidate.type === "AwaitExpression")) {
      close();
      continue;
    }
    if (isPositiveAssertion(statement)) open.positive = true;
  }
  close();
  return windows;
}

/** The function definitions a top-level statement makes, exported or not. */
function topLevelDefinitions(statement: AnyNode): Definition[] {
  const declaration =
    statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
  if (!declaration) return [];
  if (declaration.type === "FunctionDeclaration" && declaration.id)
    return [{ name: declaration.id.name, fn: declaration }];
  if (declaration.type !== "VariableDeclaration") return [];
  return declaration.declarations.flatMap((declarator: AnyNode) =>
    declarator.id.type === "Identifier" && declarator.init && isFunction(unwrap(declarator.init))
      ? [{ name: declarator.id.name, fn: unwrap(declarator.init) }]
      : [],
  );
}

/** Sleep helpers a support module defines at top level, keyed by path and checked against its text. */
const supportHelperCache = new Map<string, { source: string; helpers: Map<string, LocalSleep> }>();

function supportModuleHelpers(relative: string, source: string): Map<string, LocalSleep> {
  const cached = supportHelperCache.get(relative);
  if (cached && cached.source === source) return cached.helpers;
  const { program, errors } = parseSync(relative, source, {
    preserveParens: false,
    astType: "js",
  });
  // An unparsable support module contributes nothing; its own scan reports the error.
  const helpers =
    errors.length > 0
      ? new Map<string, LocalSleep>()
      : buildContext((program as unknown as AnyNode).body.flatMap(topLevelDefinitions), new Set())
          .helpers;
  supportHelperCache.set(relative, { source, helpers });
  return helpers;
}

/** Candidate files for a relative module specifier, as Bun resolves `./x.js` to `./x.ts`. */
function resolutionCandidates(importer: string, specifier: string): string[] {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const stem = base.replace(/\.[cm]?js$/, "");
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}/index.ts`, `${stem}/index.tsx`];
}

/**
 * Sleep helpers a file imports from a relative test-support module, keyed by
 * their local name. Moving `settle` into a `*-test-support` module must not hide
 * the windows it creates in the files that call it.
 */
function importedHelpers(node: AnyNode, file: ScannedFile): Map<string, LocalSleep> {
  const found = new Map<string, LocalSleep>();
  const specifier = node.source?.value;
  if (!file.readSource || typeof specifier !== "string" || !specifier.startsWith(".")) return found;
  if (node.importKind === "type") return found;
  for (const candidate of resolutionCandidates(file.path, specifier)) {
    if (!isTestSource(candidate)) continue;
    const source = file.readSource(candidate);
    if (source === null) continue;
    const helpers = supportModuleHelpers(candidate, source);
    for (const specifierNode of node.specifiers ?? []) {
      if (specifierNode.type !== "ImportSpecifier" || specifierNode.importKind === "type") continue;
      const imported = specifierNode.imported;
      const importedName = imported.type === "Identifier" ? imported.name : imported.value;
      const helper = helpers.get(importedName);
      if (helper) found.set(specifierNode.local.name, helper);
    }
    break;
  }
  return found;
}

/**
 * Walks a file for fixed sleeps and reports the windows `report` selects.
 * Shared by the negative- and positive-assertion guards, which select
 * disjoint windows so no sleep is counted twice.
 */
export function visitSleepWindows(
  file: ScannedFile,
  report: (window: SleepWindow) => boolean,
): GuardVisitor {
  const definitions: Definition[] = [];
  const declared = new Set<string>();
  const imported = new Map<string, LocalSleep>();
  const lists: AnyNode[][] = [];
  const collectStatements = (statements: AnyNode[]): void => {
    // A sleep and a later assertion need two statements.
    if (statements.length > 1) lists.push(statements);
  };
  return {
    handlers: {
      ImportDeclaration(node) {
        for (const [name, helper] of importedHelpers(node, file)) imported.set(name, helper);
      },
      FunctionDeclaration(node) {
        if (!node.id) return;
        definitions.push({ name: node.id.name, fn: node });
        declared.add(node.id.name);
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier") return;
        declared.add(node.id.name);
        if (node.init && isFunction(unwrap(node.init)))
          definitions.push({ name: node.id.name, fn: unwrap(node.init) });
      },
      Program: (node) => collectStatements(node.body),
      BlockStatement: (node) => collectStatements(node.body),
      StaticBlock: (node) => collectStatements(node.body),
      SwitchCase: (node) => collectStatements(node.consequent),
    },
    finish() {
      const context = buildContext(definitions, declared);
      for (const [name, helper] of imported) {
        if (declared.has(name) || context.helpers.has(name)) continue;
        context.helpers.set(name, helper);
      }
      return lists.flatMap((statements) =>
        sleepWindows(statements, context)
          .filter(report)
          .map((window) => window.offset),
      );
    },
  };
}

/** A known sleep or a Promise-wrapped `setTimeout` with a positive literal delay. */
export const FIXED_SLEEP_TEXT =
  /\b(?:[sS]leep|delay|delayMs|wait|waitMs|pause|waitForTimeout)\(\s*[1-9]|setTimeout\(\s*\w+\s*,\s*[1-9]/;
/** A local helper that sleeps for a variable delay, e.g. `(ms) => new Promise((r) => setTimeout(r, ms))`. */
export const SLEEP_HELPER_TEXT = /setTimeout\(\s*\w+\s*,\s*[a-zA-Z_]|\b[sS]leep\(\s*[a-zA-Z_]/;
/** An awaited call with a positive literal argument, such as `await realTick(50)`. */
export const AWAITED_LITERAL_CALL_TEXT = /await\s+[\w.$]+\(\s*(?:[\w.]+\s*,\s*)?[1-9]/;
/** A relative import of a test-support module, which may define the file's sleep helpers. */
export const SUPPORT_IMPORT_TEXT =
  /from\s+["']\.{1,2}\/[^"']*(?:test-harness|test-support|fixture)[^"']*["']/i;
/** Cheap text test: the file may contain a fixed sleep the AST walk would recognise. */
export function mayHaveFixedSleep(source: string): boolean {
  return (
    FIXED_SLEEP_TEXT.test(source) ||
    ((SLEEP_HELPER_TEXT.test(source) || SUPPORT_IMPORT_TEXT.test(source)) &&
      AWAITED_LITERAL_CALL_TEXT.test(source))
  );
}

const NEGATIVE_MATCHER_TEXT =
  /\.not\.|\.to(?:Be\((?:0|false)\)|HaveLength\(0\)|(?:Strict)?Equal\(\[\]\)|(?:HaveBeen|Be)CalledTimes|BeUndefined|BeNull|BeFalsy)/;

export const sleepBeforeNegativeAssertion: SourceGuard = {
  id: "sleep-before-negative-assertion",
  advice:
    "A fixed sleep followed by a check that something did not happen (or happened an exact " +
    "number of times) only proves the sleep was shorter than the work, which a loaded host " +
    "does not guarantee. Drive the delay with ManualClock " +
    "(@orkestrator/protocol/testing/manual-clock) or installControlledTimeout " +
    "(tests/helpers/controlled-timeout.ts) and advance it past the deadline, or await the " +
    "event itself, then assert. See docs/development/testing-guide.md, 'Controlled time'.",
  appliesTo: () => true,
  mayOffend: (source) => mayHaveFixedSleep(source) && NEGATIVE_MATCHER_TEXT.test(source),
  visit: (_program, file) => visitSleepWindows(file, (window) => window.negative),
};
