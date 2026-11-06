import { visitorKeys } from "oxc-parser";

/**
 * Any ESTree node, read loosely. The guards inspect shapes rather than
 * narrowing oxc's node union, and they parse with the JS-shaped AST, whose
 * fields differ from the TypeScript-shaped types anyway.
 */
export type AnyNode = { type: string; start: number; end: number } & Record<string, any>;

export function forEachChild(node: AnyNode, visit: (child: AnyNode) => void): void {
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child) visit(child as AnyNode);
    } else if (value) {
      visit(value as AnyNode);
    }
  }
}

/**
 * Visits every node depth-first, passing the chain of ancestors (outermost
 * first). The array is reused between calls: copy it to keep it.
 */
export function walk(
  root: AnyNode,
  visit: (node: AnyNode, ancestors: readonly AnyNode[]) => void,
): void {
  const ancestors: AnyNode[] = [];
  const step = (node: AnyNode): void => {
    visit(node, ancestors);
    const keys = visitorKeys[node.type];
    if (!keys || keys.length === 0) return;
    ancestors.push(node);
    for (const key of keys) {
      const value = node[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child) step(child as AnyNode);
      } else {
        step(value as AnyNode);
      }
    }
    ancestors.pop();
  };
  step(root);
}

/**
 * The chain of nodes from `root` down to `target`, outermost first and
 * excluding `target`, found by source span. For the rare node that needs its
 * context; the scan itself keeps no ancestor stack.
 */
export function ancestorsOf(root: AnyNode, target: AnyNode): AnyNode[] {
  const ancestors: AnyNode[] = [];
  let current: AnyNode | undefined = root;
  while (current && current !== target) {
    ancestors.push(current);
    let next: AnyNode | undefined;
    forEachChild(current, (child) => {
      if (!next && child.start <= target.start && child.end >= target.end) next = child;
    });
    current = next;
  }
  return ancestors;
}

export const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

export function isFunction(node: AnyNode | null | undefined): boolean {
  return !!node && FUNCTION_TYPES.has(node.type);
}

/** Looks through type assertions, non-null assertions and parentheses. */
export function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "ChainExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSSatisfiesExpression"
  )
    current = current.expression;
  return current;
}

/** The member named by `a.b` or `a["b"]`. */
export function memberName(node: AnyNode | null | undefined): string | undefined {
  if (!node || node.type !== "MemberExpression") return undefined;
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : undefined;
}

/** `f` for `f(...)`, `b` for `a.b(...)`. */
export function calleeName(call: AnyNode): string | undefined {
  const callee = unwrap(call.callee);
  return callee.type === "Identifier" ? callee.name : memberName(callee);
}

/** Whether `node` is the member expression `object.property`, e.g. `Bun.sleep`. */
export function isMember(node: AnyNode, object: string, property: string): boolean {
  const target = unwrap(node);
  return (
    target.type === "MemberExpression" &&
    unwrap(target.object).type === "Identifier" &&
    unwrap(target.object).name === object &&
    memberName(target) === property
  );
}

/** The value of a numeric literal, including a negated one; otherwise `undefined`. */
export function numericValue(node: AnyNode | null | undefined): number | undefined {
  if (!node) return undefined;
  const target = unwrap(node);
  if (target.type === "Literal" && typeof target.value === "number") return target.value;
  if (target.type === "UnaryExpression" && target.operator === "-") {
    const inner = numericValue(target.argument);
    return inner === undefined ? undefined : -inner;
  }
  return undefined;
}

/** The key of a non-computed object property or class member. */
export function propertyKey(node: AnyNode): string | undefined {
  if (node.computed) return undefined;
  const key = node.key;
  if (!key) return undefined;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

/** The innermost identifier a member/call chain starts from: `a` in `a.b(c).d`. */
export function chainRoot(node: AnyNode): AnyNode {
  let current = unwrap(node);
  for (;;) {
    if (current.type === "MemberExpression") current = unwrap(current.object);
    else if (current.type === "CallExpression") current = unwrap(current.callee);
    else if (current.type === "TaggedTemplateExpression") current = unwrap(current.tag);
    else return current;
  }
}

/** Whether `node` contains a node matching `predicate`, not looking inside nested functions. */
export function containsOutsideFunctions(
  node: AnyNode,
  predicate: (candidate: AnyNode) => boolean,
): boolean {
  let found = false;
  const visit = (candidate: AnyNode): void => {
    if (found) return;
    if (predicate(candidate)) {
      found = true;
      return;
    }
    if (isFunction(candidate) || candidate.type === "ClassBody") return;
    forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

/** Whether `node` contains a node matching `predicate`, nested functions included. */
export function contains(node: AnyNode, predicate: (candidate: AnyNode) => boolean): boolean {
  let found = false;
  const visit = (candidate: AnyNode): void => {
    if (found) return;
    if (predicate(candidate)) {
      found = true;
      return;
    }
    forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

/** Every identifier name a function binds as a parameter, destructured ones included. */
export function parameterNames(fn: AnyNode): Set<string> {
  const names = new Set<string>();
  const collect = (pattern: AnyNode | null | undefined): void => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        names.add(pattern.name);
        break;
      case "AssignmentPattern":
        collect(pattern.left);
        break;
      case "RestElement":
        collect(pattern.argument);
        break;
      case "TSParameterProperty":
        collect(pattern.parameter);
        break;
      case "ArrayPattern":
        for (const element of pattern.elements) collect(element);
        break;
      case "ObjectPattern":
        for (const property of pattern.properties)
          collect(property.type === "RestElement" ? property : property.value);
        break;
    }
  };
  for (const param of fn.params ?? []) collect(param);
  return names;
}

/** The statements a function runs: its block, or its expression body as one statement. */
export function functionStatements(fn: AnyNode): AnyNode[] {
  const body = fn.body;
  if (!body) return [];
  if (body.type === "BlockStatement") return body.body;
  return [{ type: "ExpressionStatement", expression: body, start: body.start, end: body.end }];
}

/**
 * Whether an import declaration or specifier is type-only. The scan parses
 * with oxc's JS-shaped AST, which drops `importKind`, so this reads the text.
 */
export function isTypeOnlyImport(node: AnyNode, source: string): boolean {
  if (node.type === "ImportDeclaration")
    return /^import\s+type\b/.test(source.slice(node.start, node.end));
  return /\btype\s+$/.test(source.slice(Math.max(0, node.start - 8), node.start));
}
