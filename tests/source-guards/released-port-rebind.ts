import {
  ancestorsOf,
  calleeName,
  chainRoot,
  contains,
  isFunction,
  isMember,
  memberName,
  numericValue,
  propertyKey,
  unwrap,
  walk,
  type AnyNode,
} from "./ast";
import type { GuardVisitor, SourceGuard } from "./guard";

/** Helpers named for handing out a port nobody holds, e.g. `getFreePort`, `reserveLoopbackPorts`. */
const FREE_PORT_HELPER =
  /^(?:(?:get|find|pick|allocate|reserve|choose|acquire|grab|next)(?:Free|Available|Open|Unused|Random|Loopback|Unique|Ephemeral|Spare|Unbound|Idle)+Ports?|(?:free|available|unused|random)Ports?|pickPorts?)$/;

const FREE_PORT_HELPER_TEXT =
  /(?:Free|Available|Open|Unused|Random|Loopback|Unique|Ephemeral|Spare|Unbound|Idle|free|available|unused|random|pick)Ports?\b/;

/** Packages that probe for a free port and release it before returning. */
const FREE_PORT_PACKAGES: ReadonlySet<string> = new Set([
  "get-port",
  "get-port-please",
  "portfinder",
  "detect-port",
  "find-free-port",
  "find-free-ports",
  "port-finder",
  "find-open-port",
]);

/** Calls whose callback runs as part of the same helper, not later. */
const INLINE_CALLBACK_CALLEES: ReadonlySet<string> = new Set([
  "listen",
  "once",
  "on",
  "close",
  "stop",
  "then",
  "finally",
]);

function hasPortZero(object: AnyNode | undefined): boolean {
  if (!object || unwrap(object).type !== "ObjectExpression") return false;
  return unwrap(object).properties.some(
    (property: AnyNode) =>
      property.type === "Property" &&
      propertyKey(property) === "port" &&
      numericValue(property.value) === 0,
  );
}

/** `listen(0…)`, `listen({ port: 0 })`, `Bun.serve({ port: 0 })`, `Bun.listen({ port: 0 })`. */
function isPortZeroBind(call: AnyNode): boolean {
  const callee = unwrap(call.callee);
  const first = call.arguments[0];
  if (memberName(callee) === "listen" && !isMember(callee, "Bun", "listen"))
    return numericValue(first) === 0 || hasPortZero(first);
  if (
    isMember(callee, "Bun", "serve") ||
    isMember(callee, "Bun", "listen") ||
    (callee.type === "Identifier" && callee.name === "serve")
  )
    return hasPortZero(first);
  return false;
}

/** Whether `fn`, a child of `parent`, runs as part of its caller: a Promise executor or a `listen`/`close` callback. */
function isInlineCallback(fn: AnyNode, parent: AnyNode): boolean {
  return (
    (parent.type === "NewExpression" &&
      unwrap(parent.callee).type === "Identifier" &&
      unwrap(parent.callee).name === "Promise") ||
    (parent.type === "CallExpression" &&
      INLINE_CALLBACK_CALLEES.has(calleeName(parent) ?? "") &&
      parent.arguments.includes(fn))
  );
}

/**
 * The function that owns a bind: the innermost enclosing function, widened
 * past callbacks that run inside it (a Promise executor, a `listen` or
 * `close` callback), so a helper is analysed as a whole.
 */
function owningScope(ancestors: AnyNode[]): AnyNode {
  let index = ancestors.length - 1;
  while (index >= 0 && !isFunction(ancestors[index])) index -= 1;
  while (index > 0 && isInlineCallback(ancestors[index]!, ancestors[index - 1]!)) {
    let outer = index - 1;
    while (outer >= 0 && !isFunction(ancestors[outer])) outer -= 1;
    if (outer < 0) break;
    index = outer;
  }
  return index >= 0 ? ancestors[index]! : ancestors[0]!;
}

/**
 * Whether a close runs on the helper's normal path. A close in a `catch`, in
 * a block that then throws, or in a callback kept for later (a cleanup hook)
 * does not hand a released port on.
 */
function closesOnNormalPath(ancestors: readonly AnyNode[]): boolean {
  for (let index = 1; index < ancestors.length; index += 1) {
    const ancestor = ancestors[index]!;
    if (ancestor.type === "CatchClause") return false;
    if (ancestor.type === "BlockStatement" && ancestor.body.at(-1)?.type === "ThrowStatement")
      return false;
    if (isFunction(ancestor) && !isInlineCallback(ancestor, ancestors[index - 1]!)) return false;
  }
  return true;
}

/** The variable holding the bound server, when it has one. */
function serverName(call: AnyNode, ancestors: AnyNode[]): string | undefined {
  const callee = unwrap(call.callee);
  if (memberName(callee) === "listen") {
    const receiver = unwrap(callee.object);
    if (receiver.type === "Identifier" && receiver.name !== "Bun") return receiver.name;
  }
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index]!;
    if (isFunction(ancestor)) return undefined;
    if (ancestor.type === "VariableDeclarator" && ancestor.id.type === "Identifier")
      return ancestor.id.name;
    if (ancestor.type === "AssignmentExpression" && ancestor.left.type === "Identifier")
      return ancestor.left.name;
  }
  return undefined;
}

/** `x.port`, `x.address()`, or a choice between such reads (`address ? address.port : 0`). */
function isPortRead(node: AnyNode): boolean {
  const target = unwrap(node);
  switch (target.type) {
    case "MemberExpression":
      return memberName(target) === "port";
    case "CallExpression":
      return calleeName(target) === "address";
    case "ConditionalExpression":
      return isPortRead(target.consequent) || isPortRead(target.alternate);
    case "LogicalExpression":
      return isPortRead(target.left) || isPortRead(target.right);
    case "AwaitExpression":
      return isPortRead(target.argument);
    case "NewExpression":
      // `await new Promise((resolve) => server.listen(0, () => resolve(server.address().port)))`
      return (
        unwrap(target.callee).type === "Identifier" &&
        unwrap(target.callee).name === "Promise" &&
        contains(target, (candidate) => candidate !== target && isPortRead(candidate))
      );
    default:
      return false;
  }
}

/** Whether the scope reads the bound port into a name and uses that name after closing the server. */
function usesPortAfterClose(scope: AnyNode, server: string | undefined): boolean {
  const portNames = new Set<string>();
  const declarations = new Set<AnyNode>();
  let firstClose = Number.POSITIVE_INFINITY;
  walk(scope, (node, ancestors) => {
    if (node.type === "VariableDeclarator" && node.init && isPortRead(node.init)) {
      if (node.id.type === "Identifier") {
        portNames.add(node.id.name);
        declarations.add(node.id);
      } else if (node.id.type === "ObjectPattern") {
        for (const property of node.id.properties) {
          if (property.type === "Property" && propertyKey(property) === "port") {
            const value =
              property.value.type === "AssignmentPattern" ? property.value.left : property.value;
            if (value.type === "Identifier") {
              portNames.add(value.name);
              declarations.add(value);
            }
          }
        }
      }
    } else if (
      node.type === "AssignmentExpression" &&
      node.left.type === "Identifier" &&
      isPortRead(node.right)
    ) {
      portNames.add(node.left.name);
    } else if (
      node.type === "CallExpression" &&
      calleeName(node) === "push" &&
      node.arguments.some(isPortRead)
    ) {
      const receiver = unwrap(unwrap(node.callee).object);
      if (receiver.type === "Identifier") portNames.add(receiver.name);
    } else if (node.type === "CallExpression") {
      const name = calleeName(node);
      if (name !== "close" && name !== "stop") return;
      const callee = unwrap(node.callee);
      if (callee.type !== "MemberExpression") return;
      const receiver = chainRoot(callee.object);
      if (server && !(receiver.type === "Identifier" && receiver.name === server)) return;
      if (!closesOnNormalPath(ancestors)) return;
      firstClose = Math.min(firstClose, node.start);
    }
  });
  if (portNames.size === 0 || firstClose === Number.POSITIVE_INFINITY) return false;
  let used = false;
  walk(scope, (node) => {
    if (
      node.type === "Identifier" &&
      node.start > firstClose &&
      portNames.has(node.name) &&
      !declarations.has(node)
    )
      used = true;
  });
  return used;
}

function visitPorts(program: AnyNode): GuardVisitor {
  const findings: number[] = [];
  const binds: AnyNode[] = [];
  const freePortLocals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || !FREE_PORT_PACKAGES.has(statement.source.value))
      continue;
    for (const specifier of statement.specifiers) freePortLocals.add(specifier.local.name);
  }
  return {
    handlers: {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const name = callee.type === "Identifier" ? callee.name : memberName(callee);
        if (!name) return;
        if (
          FREE_PORT_HELPER.test(name) ||
          (callee.type === "Identifier" && freePortLocals.has(name))
        )
          findings.push(node.start);
        else if (isPortZeroBind(node)) binds.push(node);
      },
    },
    finish() {
      const flagged = new Set<AnyNode>();
      for (const node of binds) {
        const ancestors = ancestorsOf(program, node);
        // Releasing and rebinding under retryOnAddressInUse is the cure, not the race.
        if (
          ancestors.some(
            (ancestor) =>
              ancestor.type === "CallExpression" && calleeName(ancestor) === "retryOnAddressInUse",
          )
        )
          continue;
        const scope = owningScope([...ancestors, node]);
        if (flagged.has(scope)) continue;
        if (usesPortAfterClose(scope, serverName(node, ancestors))) {
          flagged.add(scope);
          findings.push(node.start);
        }
      }
      return findings.sort((left, right) => left - right);
    },
  };
}

export const releasedPortRebind: SourceGuard = {
  id: "released-port-rebind",
  advice:
    "Binding port 0, reading the port and closing the server hands out a port nobody holds; " +
    "another process can take it before it is bound again (flake cases 1654, 1410, 0514, " +
    "1202). Bind port 0 in the component itself and read back the bound port, keep the " +
    "probing server bound until the port's real owner takes over, or retry on EADDRINUSE " +
    "with retryOnAddressInUse from @orkestrator/protocol/testing/ports.",
  appliesTo: () => true,
  // Split into literal-anchored checks: one alternation over every name is several times slower.
  mayOffend: (source) =>
    (source.includes("listen(") && /listen\(\s*(?:0\b|\{)/.test(source)) ||
    /port\s*:\s*0\b/.test(source) ||
    (/Ports?\b/.test(source) && FREE_PORT_HELPER_TEXT.test(source)) ||
    [...FREE_PORT_PACKAGES].some((name) => source.includes(name)),
  visit: (program) => visitPorts(program),
};
