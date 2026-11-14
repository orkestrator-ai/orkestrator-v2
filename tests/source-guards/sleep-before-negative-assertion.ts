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

/** Whether a statement is `expect(...)...<matcher>(...)` with a negative or exact-count matcher. */
export function isNegativeAssertion(statement: AnyNode): boolean {
  if (statement.type !== "ExpressionStatement") return false;
  let call = unwrap(statement.expression);
  if (call.type === "AwaitExpression") call = unwrap(call.argument);
  if (call.type !== "CallExpression") return false;
  const callee = unwrap(call.callee);
  const matcher = memberName(callee);
  if (!matcher || callee.type !== "MemberExpression") return false;
  let negated = false;
  let receiver = unwrap(callee.object);
  while (receiver.type === "MemberExpression") {
    if (memberName(receiver) === "not") negated = true;
    receiver = unwrap(receiver.object);
  }
  if (receiver.type !== "CallExpression") return false;
  const expectCallee = unwrap(receiver.callee);
  const isExpect =
    (expectCallee.type === "Identifier" && expectCallee.name === "expect") ||
    (expectCallee.type === "MemberExpression" &&
      unwrap(expectCallee.object).type === "Identifier" &&
      unwrap(expectCallee.object).name === "expect");
  if (!isExpect) return false;
  if (negated || ALWAYS_NEGATIVE_MATCHERS.has(matcher)) return true;
  const expected = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  if (!expected) return false;
  if (matcher === "toBe")
    return expected.type === "Literal" && (expected.value === 0 || expected.value === false);
  if (matcher === "toHaveLength") return numericValue(expected) === 0;
  if (matcher === "toEqual" || matcher === "toStrictEqual")
    return expected.type === "ArrayExpression" && expected.elements.length === 0;
  return false;
}

/** Offsets of each sleep in `statements` that a negative assertion follows before any other await. */
function sleepsBeforeNegativeAssertions(
  statements: readonly AnyNode[],
  context: Context,
): number[] {
  const findings: number[] = [];
  let armed: AnyNode | undefined;
  let reported = false;
  for (const statement of statements) {
    if (
      statement.type === "ExpressionStatement" &&
      unwrap(statement.expression).type === "AwaitExpression" &&
      isFixedSleep(statement.expression, context)
    ) {
      armed = statement;
      reported = false;
      continue;
    }
    if (!armed) continue;
    if (isNegativeAssertion(statement)) {
      if (!reported) findings.push(armed.start);
      reported = true;
      continue;
    }
    if (containsOutsideFunctions(statement, (candidate) => candidate.type === "AwaitExpression"))
      armed = undefined;
  }
  return findings;
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

function visitSleeps(file: ScannedFile): GuardVisitor {
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
      return lists.flatMap((statements) => sleepsBeforeNegativeAssertions(statements, context));
    },
  };
}

/** A known sleep or a Promise-wrapped `setTimeout` with a positive literal delay. */
const FIXED_SLEEP_TEXT =
  /\b(?:[sS]leep|delay|delayMs|wait|waitMs|pause|waitForTimeout)\(\s*[1-9]|setTimeout\(\s*\w+\s*,\s*[1-9]/;
/** A local helper that sleeps for a variable delay, e.g. `(ms) => new Promise((r) => setTimeout(r, ms))`. */
const SLEEP_HELPER_TEXT = /setTimeout\(\s*\w+\s*,\s*[a-zA-Z_]|\b[sS]leep\(\s*[a-zA-Z_]/;
/** An awaited call with a positive literal argument, such as `await realTick(50)`. */
const AWAITED_LITERAL_CALL_TEXT = /await\s+[\w.$]+\(\s*(?:[\w.]+\s*,\s*)?[1-9]/;
/** A relative import of a test-support module, which may define the file's sleep helpers. */
const SUPPORT_IMPORT_TEXT =
  /from\s+["']\.{1,2}\/[^"']*(?:test-harness|test-support|fixture)[^"']*["']/i;
const NEGATIVE_MATCHER_TEXT =
  /\.not\.|\.to(?:Be\((?:0|false)\)|HaveLength\(0\)|(?:Strict)?Equal\(\[\]\)|(?:HaveBeen|Be)CalledTimes|BeUndefined|BeNull|BeFalsy)/;

export const sleepBeforeNegativeAssertion: SourceGuard = {
  id: "sleep-before-negative-assertion",
  advice:
    "A fixed sleep followed by a check that something did not happen (or happened an exact " +
    "number of times) only proves the sleep was shorter than the work, which a loaded host " +
    "does not guarantee. Capture the delay with installControlledTimeout " +
    "(tests/helpers/controlled-timeout.ts) and advance it, or await the event itself, then " +
    "assert. See docs/development/testing-guide.md, 'Controlled time'.",
  appliesTo: () => true,
  mayOffend: (source) =>
    (FIXED_SLEEP_TEXT.test(source) ||
      ((SLEEP_HELPER_TEXT.test(source) || SUPPORT_IMPORT_TEXT.test(source)) &&
        AWAITED_LITERAL_CALL_TEXT.test(source))) &&
    NEGATIVE_MATCHER_TEXT.test(source),
  visit: (_program, file) => visitSleeps(file),
};
