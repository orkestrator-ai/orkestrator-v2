import { contains, memberName, numericValue, propertyKey, unwrap, walk, type AnyNode } from "./ast";
import type { GuardVisitor, SourceGuard } from "./guard";

/** Linux's largest `pid_max`. Any pid below it can name a live process or process group. */
export const PID_MAX = 4_194_304;

/** Class and constructor names that describe a child process. */
const CHILD_SHAPED_CLASS = /Child|Process/;
/** Classes whose `pid` field is a child's pid. */
const PID_OWNING_CLASS = /Child|Process|Fake/;
/** Variables holding a child process, e.g. `child.pid = 1234`. */
const CHILD_SHAPED_VARIABLE = /child|proc|subprocess/i;
/** Members a child process (Node `ChildProcess` or a Bun `Subprocess`) has besides `pid`. */
const CHILD_MEMBERS: ReadonlySet<string> = new Set([
  "kill",
  "stdin",
  "stdout",
  "stderr",
  "on",
  "once",
  "exitCode",
  "exited",
]);

function mentionsPidName(node: AnyNode): boolean {
  return contains(
    node,
    (candidate) => candidate.type === "Identifier" && /pid/i.test(candidate.name),
  );
}

/**
 * Whether a pid expression can evaluate to a real pid: a literal below
 * {@link PID_MAX} (0 and 1 included), or arithmetic on one such as
 * `1000 + index`. Arithmetic on a named pid base (`FAKE_PID_BASE + n`) is
 * trusted.
 */
export function isPlausiblePid(expression: AnyNode | null | undefined): boolean {
  if (!expression) return false;
  const target = unwrap(expression);
  const value = numericValue(target);
  if (value !== undefined) return value < PID_MAX;
  switch (target.type) {
    case "BinaryExpression":
      if (!["+", "-", "*"].includes(target.operator) || mentionsPidName(target)) return false;
      return [target.left, target.right].some(
        (operand) => (numericValue(operand) ?? PID_MAX) < PID_MAX,
      );
    case "LogicalExpression":
      return isPlausiblePid(target.left) || isPlausiblePid(target.right);
    case "ConditionalExpression":
      return isPlausiblePid(target.consequent) || isPlausiblePid(target.alternate);
    default:
      return false;
  }
}

function pidProperty(object: AnyNode): AnyNode | undefined {
  return object.properties.find(
    (property: AnyNode) => property.type === "Property" && propertyKey(property) === "pid",
  );
}

/** Keys of a finished process's result (`spawnSync`'s), which nothing signals. */
const RESULT_MEMBERS: ReadonlySet<string> = new Set(["status", "output", "success"]);

function isChildShapedObject(object: AnyNode): boolean {
  const keys = new Set<string>();
  for (const property of object.properties)
    if (property.type === "Property") keys.add(propertyKey(property) ?? "");
  if (!keys.has("kill") && [...RESULT_MEMBERS].some((key) => keys.has(key))) return false;
  return [...CHILD_MEMBERS].some((key) => keys.has(key));
}

function className(node: AnyNode): string | undefined {
  return node.id?.name;
}

/** `pid = 1234` fields, `this.pid = 1234` and `pid = 1234` constructor defaults inside a child-shaped class. */
function classFindings(body: AnyNode, findings: number[]): void {
  walk(body, (node) => {
    if (
      node.type === "PropertyDefinition" &&
      propertyKey(node) === "pid" &&
      isPlausiblePid(node.value)
    )
      findings.push(node.start);
    else if (
      node.type === "AssignmentExpression" &&
      unwrap(node.left).type === "MemberExpression" &&
      unwrap(unwrap(node.left).object).type === "ThisExpression" &&
      memberName(unwrap(node.left)) === "pid" &&
      isPlausiblePid(node.right)
    )
      findings.push(node.start);
    else if (node.type === "MethodDefinition" && node.kind === "constructor") {
      for (const param of node.value.params) {
        const pattern = param.type === "TSParameterProperty" ? param.parameter : param;
        if (
          pattern.type === "AssignmentPattern" &&
          pattern.left.type === "Identifier" &&
          pattern.left.name === "pid" &&
          isPlausiblePid(pattern.right)
        )
          findings.push(pattern.start);
      }
    }
  });
}

function visitPids(): GuardVisitor {
  const findings: number[] = [];
  const reported = new Set<AnyNode>();
  const visitClass = (node: AnyNode): void => {
    if (PID_OWNING_CLASS.test(className(node) ?? "")) classFindings(node.body, findings);
  };
  return {
    handlers: {
      ClassDeclaration: visitClass,
      ClassExpression: visitClass,
      NewExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type !== "Identifier" || !CHILD_SHAPED_CLASS.test(callee.name)) return;
        if (isPlausiblePid(node.arguments[0])) {
          findings.push(node.start);
          return;
        }
        for (const argument of node.arguments) {
          const object = unwrap(argument);
          if (object.type !== "ObjectExpression") continue;
          const pid = pidProperty(object);
          if (pid && isPlausiblePid(pid.value)) {
            findings.push(pid.start);
            reported.add(object);
          }
        }
      },
      // Visited after the NewExpression that may hold it, so `reported` is already filled.
      ObjectExpression(node) {
        if (reported.has(node)) return;
        const pid = pidProperty(node);
        if (pid && isPlausiblePid(pid.value) && isChildShapedObject(node)) findings.push(pid.start);
      },
      AssignmentExpression(node) {
        const target = unwrap(node.left);
        if (target.type !== "MemberExpression" || memberName(target) !== "pid") return;
        const object = unwrap(target.object);
        if (
          object.type === "Identifier" &&
          CHILD_SHAPED_VARIABLE.test(object.name) &&
          isPlausiblePid(node.right)
        )
          findings.push(node.start);
      },
    },
    finish: () => [...new Set(findings)].sort((left, right) => left - right),
  };
}

export const smallFakePid: SourceGuard = {
  id: "small-fake-pid",
  advice:
    "A fake child process with a pid below pid_max (4_194_304; 0 and 1 included) can be " +
    "signalled for real: code under test that kills the child's process group " +
    "(process.kill(-pid)) reaches whatever live group holds that number, as happened in " +
    "codex-bridge (commit 5195fbee8). Use FAKE_PID_BASE / fakePid(n) from " +
    "@orkestrator/protocol/testing/fake-pids. Pids that are only data (process tables, " +
    "log fields, arguments to injected functions) are fine.",
  appliesTo: () => true,
  // A `pid` given a value that contains a digit, or a child-shaped constructor call.
  mayOffend: (source) =>
    (source.includes("pid") && /\bpid\??\s*(?::\s*number\s*)?[:=][^,;\n)]*\d/.test(source)) ||
    ((source.includes("Child") || source.includes("Process")) &&
      /new \w*(?:Child|Process)\w*\(/.test(source)),
  visit: () => visitPids(),
};
