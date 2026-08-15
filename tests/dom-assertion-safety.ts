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
      let containsDomQuery = false;
      const findQuery = (candidate: ts.Node): void => {
        if (
          ts.isCallExpression(candidate)
          && isDomProducingQuery(candidate.expression)
        ) containsDomQuery = true;
        else candidate.forEachChild(findQuery);
      };
      if (received) findQuery(received);
      if (received && containsDomQuery) {
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
