import * as ts from "typescript";

export type UnsafeDomAssertion = {
  start: number;
  end: number;
  receivedStart: number;
  receivedEnd: number;
};

function isDomProducingQuery(expression: ts.LeftHandSideExpression): boolean {
  const name = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : ts.isIdentifier(expression)
      ? expression.text
      : "";
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

function containsDomQuery(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(candidate) && isDomProducingQuery(candidate.expression)) {
      found = true;
      return;
    }
    candidate.forEachChild(visit);
  };
  visit(node);
  return found;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return unwrapExpression(expression.expression);
  return expression;
}

/** The member being read, whether written `a.b` or `a["b"]`. */
function projectedName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression)
  )
    return expression.argumentExpression.text;
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
function isKnownScalarDomProjection(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isCallExpression(unwrapped)) {
    const method = projectedName(unwrapExpression(unwrapped.expression));
    return method !== undefined && DOM_SCALAR_METHODS.has(method);
  }
  const property = projectedName(unwrapped);
  return property !== undefined && DOM_SCALAR_PROPERTIES.has(property);
}

export function findUnsafeDomAbsenceAssertions(
  fileName: string,
  source: string,
): UnsafeDomAssertion[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const assertions: UnsafeDomAssertion[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toBeNull" &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "expect"
    ) {
      const received = node.expression.expression.arguments[0];
      if (received && containsDomQuery(received) && !isKnownScalarDomProjection(received)) {
        assertions.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          receivedStart: received.getStart(sourceFile),
          receivedEnd: received.getEnd(),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
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
