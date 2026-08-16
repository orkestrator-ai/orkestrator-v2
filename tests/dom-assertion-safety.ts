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
  return name === "querySelector"
    || name === "querySelectorAll"
    || name === "closest"
    || /^(?:query|get|find)(?:All)?By[A-Z]/.test(name)
    || /^getElements?By[A-Z]/.test(name);
}

const DOM_SCALAR_METHODS = new Set([
  "getAttribute",
  "getAttributeNS",
  "hasAttribute",
  "hasAttributeNS",
  "matches",
]);

const DOM_SCALAR_PROPERTIES = new Set([
  "checked",
  "className",
  "disabled",
  "id",
  "innerHTML",
  "length",
  "nodeName",
  "nodeType",
  "nodeValue",
  "outerHTML",
  "selected",
  "tagName",
  "textContent",
  "value",
]);

function containsDomQuery(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(candidate)
      && isDomProducingQuery(candidate.expression)
    ) {
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
    ts.isParenthesizedExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) return unwrapExpression(expression.expression);
  return expression;
}

function isKnownScalarDomProjection(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (
    ts.isCallExpression(unwrapped)
    && ts.isPropertyAccessExpression(unwrapped.expression)
    && DOM_SCALAR_METHODS.has(unwrapped.expression.name.text)
  ) {
    return containsDomQuery(unwrapped.expression.expression);
  }
  return ts.isPropertyAccessExpression(unwrapped)
    && DOM_SCALAR_PROPERTIES.has(unwrapped.name.text)
    && containsDomQuery(unwrapped.expression);
}

export function findUnsafeDomAbsenceAssertions(fileName: string, source: string): UnsafeDomAssertion[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const assertions: UnsafeDomAssertion[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "toBeNull"
      && ts.isCallExpression(node.expression.expression)
      && ts.isIdentifier(node.expression.expression.expression)
      && node.expression.expression.expression.text === "expect"
    ) {
      const received = node.expression.expression.arguments[0];
      if (
        received
        && containsDomQuery(received)
        && !isKnownScalarDomProjection(received)
      ) {
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
