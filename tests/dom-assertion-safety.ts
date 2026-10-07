import { parseSync, visitorKeys, type Expression, type Node } from "oxc-parser";

export type UnsafeDomAssertion = {
  start: number;
  end: number;
  receivedStart: number;
  receivedEnd: number;
};

function forEachChild(node: Node, visit: (child: Node) => void): void {
  for (const key of visitorKeys[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child) visit(child as Node);
    } else if (value) {
      visit(value as Node);
    }
  }
}

/** The member named by `a.b`; `undefined` for `a[b]` and `a.#b`. */
function staticMemberName(expression: Expression): string | undefined {
  return expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier"
    ? expression.property.name
    : undefined;
}

function isDomProducingQuery(callee: Expression): boolean {
  const name = staticMemberName(callee) ?? (callee.type === "Identifier" ? callee.name : "");
  return (
    name === "querySelector" ||
    name === "querySelectorAll" ||
    name === "closest" ||
    /^(?:query|get|find)(?:All)?By[A-Z]/.test(name) ||
    /^getElements?By[A-Z]/.test(name)
  );
}

/**
 * Method calls whose result is a single attribute value or a boolean, never a
 * node and never proportional to the element's descendants.
 */
export const DOM_SCALAR_METHODS: ReadonlySet<string> = new Set([
  "getAttribute",
  "getAttributeNS",
  "hasAttribute",
  "hasAttributeNS",
  "matches",
]);

/**
 * Property reads whose value is a single scalar — an attribute, a flag, a count
 * or a name.
 *
 * `innerHTML`, `outerHTML` and `textContent` are deliberately absent. They are
 * scalars in type only: their length is the element's entire descendant
 * subtree, and Bun prints a received string in a failing `toBeNull()`
 * diagnostic in full, with no cap. Exempting them would reopen the unbounded
 * output this scanner exists to close, just in string form rather than node
 * form. Write those as `expect(x === null).toBe(true)`, which prints `false`.
 */
export const DOM_SCALAR_PROPERTIES: ReadonlySet<string> = new Set([
  "checked",
  "className",
  "disabled",
  "id",
  "length",
  "nodeName",
  "nodeType",
  "nodeValue",
  "selected",
  "tagName",
  "value",
]);

function containsDomQuery(node: Node): boolean {
  let found = false;
  const visit = (candidate: Node): void => {
    if (found) return;
    if (candidate.type === "CallExpression" && isDomProducingQuery(candidate.callee)) {
      found = true;
      return;
    }
    forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

/**
 * ESTree wraps an optional chain (`a?.b`) in a `ChainExpression`, which carries
 * no meaning here, so it is looked through like the TypeScript wrappers.
 */
function unwrapExpression(expression: Expression): Expression {
  if (
    expression.type === "ParenthesizedExpression" ||
    expression.type === "ChainExpression" ||
    expression.type === "TSNonNullExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSTypeAssertion" ||
    expression.type === "TSSatisfiesExpression"
  )
    return unwrapExpression(expression.expression);
  return expression;
}

/** The member being read, whether written `a.b` or `a["b"]`. */
function projectedName(expression: Expression): string | undefined {
  if (expression.type !== "MemberExpression") return undefined;
  if (!expression.computed) return staticMemberName(expression);
  const property = expression.property;
  if (property.type === "Literal" && typeof property.value === "string") return property.value;
  if (property.type === "TemplateLiteral" && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/**
 * Whether the outermost operation yields a scalar rather than a node.
 *
 * The caller has already established that a DOM-producing query appears
 * somewhere inside, so this only has to classify the final projection — the
 * return type of `el.getAttribute(...)` does not depend on where the query
 * sits, so this must not re-inspect the receiver.
 */
function isKnownScalarDomProjection(expression: Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === "CallExpression") {
    const method = projectedName(unwrapExpression(unwrapped.callee));
    return method !== undefined && DOM_SCALAR_METHODS.has(method);
  }
  const property = projectedName(unwrapped);
  return property !== undefined && DOM_SCALAR_PROPERTIES.has(property);
}

export function findUnsafeDomAbsenceAssertions(
  fileName: string,
  source: string,
): UnsafeDomAssertion[] {
  const { program, errors } = parseSync(fileName, source);
  // A file that does not parse must not pass the scan by yielding a partial tree.
  if (errors.length > 0) throw new Error(`${fileName}: ${errors[0]!.message}`);
  const assertions: UnsafeDomAssertion[] = [];
  const visit = (node: Node): void => {
    if (
      node.type === "CallExpression" &&
      staticMemberName(node.callee) === "toBeNull" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "CallExpression" &&
      node.callee.object.callee.type === "Identifier" &&
      node.callee.object.callee.name === "expect"
    ) {
      const received = node.callee.object.arguments[0];
      if (
        received &&
        containsDomQuery(received) &&
        (received.type === "SpreadElement" || !isKnownScalarDomProjection(received))
      ) {
        assertions.push({
          start: node.start,
          end: node.end,
          receivedStart: received.start,
          receivedEnd: received.end,
        });
      }
    }
    forEachChild(node, visit);
  };
  visit(program);
  return assertions;
}

export function rewriteUnsafeDomAbsenceAssertions(fileName: string, source: string): string {
  const assertions = findUnsafeDomAbsenceAssertions(fileName, source);
  let rewritten = source;
  for (const assertion of assertions.sort((left, right) => right.start - left.start)) {
    const received = source.slice(assertion.receivedStart, assertion.receivedEnd);
    rewritten = `${rewritten.slice(0, assertion.start)}expect(${received} === null).toBe(true)${rewritten.slice(assertion.end)}`;
  }
  return rewritten;
}
