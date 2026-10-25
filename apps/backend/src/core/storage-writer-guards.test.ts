import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseSync, visitorKeys, type CallExpression, type Node } from "oxc-parser";

/**
 * Static guard for the store write rules (`AGENTS.md` "Storage rules",
 * `docs/architecture/storage.md` "Concurrency").
 *
 * `saveJson` and `saveSensitiveJson` persist a store's complete value as a row
 * diff against the rows committed *now*, so whatever was read to build that
 * value must be serialized against every other writer of the store. A lease
 * only excludes holders of the same lease, and `updateStore`/`updateStoreRow`
 * take none. This test parses every class of the `StorageService` chain and
 * proves, per store:
 *
 * 1. every whole-value write runs inside a store-wide lease callback
 *    (`serializeMutation` or a wrapper that hands it its `operation`),
 *    directly or through private/protected helpers whose every caller does;
 * 2. all whole-value writers of one store share at least one lease;
 * 3. no store has both whole-value and transactional writers.
 *
 * A whole-value write is `saveJson`, `saveSensitiveJson`, `deleteStore`, a raw
 * `database.writeStore*`/`deleteStore*`, or an `updateStore`/`updateStoreRow`
 * reached from inside `atomically`, which buffers the value and commits it
 * whole. `super.x(...)` counts as `this.x(...)`.
 *
 * Code between the lease callback and the write may not start another
 * function (a `forEach` callback, a timer), and every asynchronous call on the
 * way (the write, each helper, `atomically`) must be awaited or returned:
 * nothing else proves it still runs while the lease is held. A lease wrapper
 * must hand its `operation` to the lease and use it nowhere else. A lease is
 * store-wide only when its target is the same string for every caller
 * (literals, readonly fields, `path` joins and helpers built from those).
 * A write in a member the analysis cannot follow fails. Store arguments must
 * name their store (`this.kanbanFile()`), so the analysis can group writers by
 * store.
 */

const coreDir = import.meta.dir;
const backendSrc = path.resolve(coreDir, "..");
const repoRoot = path.resolve(backendSrc, "../../..");

type WriteKind = "whole" | "transactional";

const WRITES = new Map<string, WriteKind>([
  ["this.saveJson", "whole"],
  ["this.saveSensitiveJson", "whole"],
  ["this.saveStore", "whole"],
  ["this.deleteStore", "whole"],
  ["this.updateStore", "transactional"],
  ["this.updateStoreRow", "transactional"],
  ["this.database.writeStore", "whole"],
  ["this.database.writeStoreInTransaction", "whole"],
  ["this.database.deleteStore", "whole"],
  ["this.database.deleteStoreInTransaction", "whole"],
  ["this.database.updateStore", "transactional"],
  ["this.database.updateStoreRow", "transactional"],
]);

/**
 * The primitives themselves: `StorageBase`'s forwarders to the `StorageContext`
 * implementations. Their bodies are not call sites.
 */
const PRIMITIVES = new Set([
  "saveJson",
  "saveSensitiveJson",
  "saveStore",
  "updateStore",
  "updateStoreRow",
  "atomically",
  "deleteStore",
]);

/** Primitives that finish before they return; every other one returns a promise. */
const SYNCHRONOUS_PRIMITIVES = new Set(["updateStore", "updateStoreRow"]);

/**
 * `StorageContext` members that write, scope or lease stores, each with the
 * one `StorageBase` forwarder allowed to reach it. Every layer writes through
 * the forwarders, which the analysis follows; a direct `this.context.saveJson`
 * would bypass it, so only the base of the chain may name `this.context`, and
 * only its forwarders may reach these members.
 */
const CONTEXT_FORWARDERS = new Map([
  ["saveJson", "saveJson"],
  ["saveSensitiveJson", "saveSensitiveJson"],
  ["deleteStore", "deleteStore"],
  ["updateStore", "updateStore"],
  ["updateStoreRow", "updateStoreRow"],
  ["atomically", "atomically"],
  ["serialize", "serializeMutation"],
  ["acquireLease", "acquireMutationLock"],
  ["database", "database"],
]);

/** Callbacks that run synchronously inside the call, in the caller's context. */
const SYNCHRONOUS_CALLBACKS = new Set(["this.database.transaction"]);

type SourceFile = { file: string; source: string };

type ParsedFile = SourceFile & { program: Node; lineStarts: number[] };

type Member = {
  className: string;
  name: string;
  accessibility: "public" | "protected" | "private";
  node: Node;
  fn: Node;
  file: ParsedFile;
};

type ClassInfo = { name: string; superName: string | null; node: Node; file: ParsedFile };

type CallSite = { call: CallExpression; ancestors: Node[]; member: Member; callee: string };

type Lease = { name: string; keyed: boolean };

type WritePath = {
  leases: Lease[];
  via: string[];
  entry: Member | null;
  problem?: string;
};

type WriteSite = {
  location: string;
  member: string;
  call: string;
  store: string;
  kind: WriteKind;
  reason?: string;
  paths: WritePath[];
};

type StoreSummary = {
  kind: WriteKind | "mixed";
  /** Store-wide leases held on every path to every whole-value write. */
  leases: string[];
  sites: number;
  paths: number;
};

type Analysis = {
  chain: string[];
  sites: WriteSite[];
  stores: Map<string, StoreSummary>;
  violations: string[];
};

function parse(source: SourceFile): ParsedFile {
  const { program, errors } = parseSync(source.file, source.source);
  // A file that does not parse must not pass by yielding a partial tree.
  if (errors.length > 0) throw new Error(`${source.file}: ${errors[0]!.message}`);
  const lineStarts = [0];
  for (let index = 0; index < source.source.length; index += 1) {
    if (source.source[index] === "\n") lineStarts.push(index + 1);
  }
  return { ...source, program: program as Node, lineStarts };
}

function lineOf(file: ParsedFile, offset: number): number {
  let low = 0;
  let high = file.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (file.lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of visitorKeys[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child) out.push(child as Node);
    } else if (value) {
      out.push(value as Node);
    }
  }
  return out;
}

function walk(node: Node, visit: (node: Node, ancestors: Node[]) => void, stack: Node[] = []) {
  visit(node, stack);
  stack.push(node);
  for (const child of children(node)) walk(child, visit, stack);
  stack.pop();
}

function unwrap(node: Node): Node {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression as Node;
  }
  return current;
}

/** `this.database.transaction` for a member chain of plain names, else `null`. */
function memberPath(node: Node): string | null {
  const target = unwrap(node);
  // `super.saveJson(...)` runs the same primitive as `this.saveJson(...)`.
  if (target.type === "ThisExpression" || target.type === "Super") return "this";
  if (target.type === "Identifier") return target.name;
  if (target.type === "MemberExpression" && !target.computed) {
    const object = memberPath(target.object as Node);
    const property = propertyName(target.property as Node);
    return object && property ? `${object}.${property}` : null;
  }
  return null;
}

/** `name` for `.name`, `#name` for `.#name`. */
function propertyName(node: Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateIdentifier") return `#${node.name}`;
  return null;
}

function calleePath(call: Node): string | null {
  return call.type === "CallExpression" ? memberPath(call.callee as Node) : null;
}

/** The method name of a `this.name(...)`, `this.#name(...)` or `super.name(...)` call. */
function ownMethodCall(call: Node): string | null {
  const callee = calleePath(call);
  const match = callee ? /^this\.(#?[A-Za-z_$][\w$]*)$/.exec(callee) : null;
  return match ? match[1]! : null;
}

function isFunction(node: Node): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

function text(file: ParsedFile, node: Node): string {
  return file.source.slice(node.start, node.end).replace(/\s+/g, " ");
}

/** Identifiers read by `node`, excluding property names. */
function freeIdentifiers(node: Node): string[] {
  const names: string[] = [];
  walk(node, (child, ancestors) => {
    if (child.type !== "Identifier") return;
    const parent = ancestors.at(-1);
    if (parent?.type === "MemberExpression" && parent.property === child && !parent.computed)
      return;
    names.push(child.name);
  });
  return names;
}

/** The expressions `fn` returns, not counting nested functions. */
function returnedExpressions(fn: Node): Node[] {
  const body = (fn as Node & { body: Node | null }).body;
  if (!body) return [];
  if (body.type !== "BlockStatement") return [body];
  const out: Node[] = [];
  const visit = (node: Node) => {
    if (isFunction(node) || node.type === "ClassDeclaration" || node.type === "ClassExpression")
      return;
    if (node.type === "ReturnStatement" && node.argument) out.push(node.argument as Node);
    for (const child of children(node)) visit(child);
  };
  for (const statement of body.body as Node[]) visit(statement);
  return out;
}

/** The returned expression of a function whose whole body is one `return`. */
function onlyReturned(fn: Node): Node | null {
  const body = (fn as Node & { body: Node | null }).body;
  if (!body) return null;
  if (body.type !== "BlockStatement") return body;
  const statements = body.body as Node[];
  const only = statements.length === 1 ? statements[0]! : null;
  return only?.type === "ReturnStatement" && only.argument ? (only.argument as Node) : null;
}

/**
 * Whether the enclosing function awaits or returns the value of `call`, so it
 * settles before that function does. `ancestors` ends with the call's parent.
 */
function settled(call: Node, ancestors: Node[]): boolean {
  let node = call;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index]!;
    switch (parent.type) {
      case "AwaitExpression":
      case "ReturnStatement":
        return true;
      case "ArrowFunctionExpression":
        return parent.body === node;
      case "ParenthesizedExpression":
      case "TSNonNullExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
        break;
      case "ConditionalExpression":
        if (parent.test === node) return false;
        break;
      case "ArrayExpression": {
        // `await Promise.all([this.a(), this.b()])`
        const all = ancestors[index - 1];
        const callee = all ? calleePath(all) : null;
        if (
          (callee !== "Promise.all" && callee !== "Promise.allSettled") ||
          (all as CallExpression).arguments[0] !== parent
        ) {
          return false;
        }
        index -= 1;
        node = all!;
        continue;
      }
      default:
        return false;
    }
    node = parent;
  }
  return false;
}

function paramNames(fn: Node): string[] {
  if (!isFunction(fn)) return [];
  return (fn as Node & { params: Node[] }).params.map((param) => {
    const target = param.type === "AssignmentPattern" ? (param.left as Node) : param;
    return target.type === "Identifier" ? target.name : "";
  });
}

function analyzeStorageWriters(sources: SourceFile[], options: { rootClass: string }): Analysis {
  const files = sources.map(parse);
  const classes = new Map<string, ClassInfo>();
  for (const file of files) {
    walk(file.program, (node) => {
      if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id) {
        const superClass = node.superClass ? unwrap(node.superClass as Node) : null;
        classes.set(node.id.name, {
          name: node.id.name,
          superName: superClass?.type === "Identifier" ? superClass.name : null,
          node,
          file,
        });
      }
    });
  }

  const chain: ClassInfo[] = [];
  for (let name: string | null = options.rootClass; name;) {
    const info = classes.get(name);
    if (!info) throw new Error(`Class ${name} of the ${options.rootClass} chain was not scanned`);
    chain.push(info);
    name = info.superName;
  }

  const members: Member[] = [];
  const readonlyFields = new Set<string>();
  for (const info of chain) {
    const body = (info.node as Node & { body: { body: Node[] } }).body.body;
    for (const node of body) {
      if (node.type !== "MethodDefinition" && node.type !== "PropertyDefinition") continue;
      const fn = node.value as Node | null;
      const key = node.key as Node;
      // A computed key cannot be called by name, so it counts as public: its
      // writes must hold their lease inside it.
      const name = node.computed ? null : propertyName(key);
      if (node.type === "PropertyDefinition" && node.readonly && name && !(fn && isFunction(fn))) {
        readonlyFields.add(name);
      }
      if (!fn || !isFunction(fn)) continue;
      members.push({
        className: info.name,
        name: name ?? `[${text(info.file, key)}]`,
        accessibility:
          key.type === "PrivateIdentifier" ? "private" : (node.accessibility ?? "public"),
        node,
        fn,
        file: info.file,
      });
    }
  }
  const membersByName = new Map<string, Member[]>();
  for (const member of members) {
    membersByName.set(member.name, [...(membersByName.get(member.name) ?? []), member]);
  }

  const calls: CallSite[] = [];
  const valueReferences = new Map<string, Array<{ member: Member; node: Node }>>();
  for (const member of members) {
    if (PRIMITIVES.has(member.name)) continue;
    const classNode = chain.find((info) => info.name === member.className)!.node;
    walk(
      member.node,
      (node, ancestors) => {
        if (node.type === "CallExpression") {
          const callee = calleePath(node);
          if (callee) calls.push({ call: node, ancestors: [...ancestors], member, callee });
          return;
        }
        if (node.type !== "MemberExpression" || node.computed) return;
        const parent = ancestors.at(-1);
        if (parent?.type === "CallExpression" && parent.callee === node) return;
        const object = unwrap(node.object as Node);
        if (object.type !== "ThisExpression" && object.type !== "Super") return;
        const name = propertyName(node.property as Node);
        if (!name) return;
        valueReferences.set(name, [...(valueReferences.get(name) ?? []), { member, node }]);
      },
      [classNode],
    );
  }
  const violations: string[] = [];
  const location = (file: ParsedFile, node: Node) => `${file.file}:${lineOf(file, node.start)}`;

  // The shared StorageContext is reached only by the chain's base, and its
  // writing members only by their forwarders.
  const baseClass = chain.at(-1)!;
  for (const info of chain) {
    walk(info.node, (node, ancestors) => {
      if (node.type !== "MemberExpression" || node.computed) return;
      if (unwrap(node.object as Node).type !== "ThisExpression") return;
      if (propertyName(node.property as Node) !== "context") return;
      const where = `${location(info.file, node)} ${info.name}`;
      if (info !== baseClass) {
        violations.push(
          `${where}: reaches this.context directly; call ${baseClass.name}'s forwarders`,
        );
        return;
      }
      const parent = ancestors.at(-1);
      const owner = members.find((member) => ancestors.includes(member.node));
      // The constructor creates it.
      if (
        parent?.type === "AssignmentExpression" &&
        parent.left === node &&
        owner?.name === "constructor"
      ) {
        return;
      }
      const accessed =
        parent?.type === "MemberExpression" && parent.object === node && !parent.computed
          ? propertyName(parent.property as Node)
          : null;
      if (!accessed) {
        violations.push(`${where}: uses this.context as a value, which the analysis cannot follow`);
        return;
      }
      const forwarder = CONTEXT_FORWARDERS.get(accessed);
      if (!forwarder) return;
      if (owner?.name !== forwarder) {
        violations.push(
          `${where}: this.context.${accessed} outside the ${forwarder} forwarder${owner ? ` (in ${owner.name})` : ""}`,
        );
      }
    });
  }

  // Writes the member walk above did not visit (a static block, a field
  // initializer) cannot be followed, so they fail.
  const collected = new Set<Node>(calls.map((site) => site.call));
  const primitiveNodes = new Set(
    members.filter((member) => PRIMITIVES.has(member.name)).map((member) => member.node),
  );
  for (const info of chain) {
    walk(info.node, (node, ancestors) => {
      if (node.type !== "CallExpression" || collected.has(node)) return;
      const callee = calleePath(node);
      if (!callee || !WRITES.has(callee)) return;
      if (ancestors.some((ancestor) => primitiveNodes.has(ancestor))) return;
      violations.push(
        `${location(info.file, node)} ${info.name}: ${callee.replace(/^this\./, "")} outside any method the analysis can follow`,
      );
    });
  }

  const callersByMethod = new Map<string, CallSite[]>();
  for (const site of calls) {
    const name = ownMethodCall(site.call);
    if (name) callersByMethod.set(name, [...(callersByMethod.get(name) ?? []), site]);
  }

  // A lease wrapper runs one of its arguments (`operation`) under a lease on
  // `target`, which is either one of its parameters or an expression of its own.
  type LeaseWrapper = {
    operation: number;
    target: { param: number } | { node: Node; file: ParsedFile };
  };
  const wrappers = new Map<string, LeaseWrapper | null>([
    ["serializeMutation", { operation: 2, target: { param: 0 } }],
  ]);
  const targetKey = (wrapper: LeaseWrapper) =>
    "param" in wrapper.target
      ? `param ${wrapper.target.param}`
      : text(wrapper.target.file, wrapper.target.node);
  const leaseWrapper = (name: string): LeaseWrapper | null => {
    if (wrappers.has(name)) return wrappers.get(name)!;
    wrappers.set(name, null);
    // Every implementation must lease its operation the same way, or a caller
    // cannot tell which lease it holds.
    const shapes = (membersByName.get(name) ?? []).map((member) => wrapperShape(member, name));
    const found = shapes[0] ?? null;
    if (
      !found ||
      shapes.some(
        (shape) =>
          !shape || shape.operation !== found.operation || targetKey(shape) !== targetKey(found),
      )
    ) {
      return null;
    }
    wrappers.set(name, found);
    return found;
  };
  const wrapperShape = (member: Member, name: string): LeaseWrapper | null => {
    const params = paramNames(member.fn);
    const inner: CallExpression[] = [];
    walk(member.fn, (node) => {
      if (node.type === "CallExpression") inner.push(node);
    });
    for (const node of inner) {
      const callee = ownMethodCall(node);
      const wrapper = callee && callee !== name ? leaseWrapper(callee) : null;
      if (!wrapper) continue;
      const operation = node.arguments[wrapper.operation] as Node | undefined;
      const operationParam = operation?.type === "Identifier" ? params.indexOf(operation.name) : -1;
      if (operationParam < 0) continue;
      // The lease must be the operation's only use: another (an unleased
      // `return operation()` branch, a timer) runs it without the lease.
      const body = (member.fn as Node & { body: Node }).body;
      const uses = freeIdentifiers(body).filter((used) => used === params[operationParam]);
      if (uses.length !== 1) return null;
      let target = wrapper.target;
      if ("param" in target) {
        const argument = node.arguments[target.param] as Node;
        const targetParam = argument.type === "Identifier" ? params.indexOf(argument.name) : -1;
        target = targetParam >= 0 ? { param: targetParam } : { node: argument, file: member.file };
      }
      return { operation: operationParam, target };
    }
    return null;
  };

  // A lease target is store-wide only when it is the same string for every
  // caller. Anything read from a local, a parameter the caller fills in from
  // its own state, or a mutable field names one key's lease.
  const stableMethods = new Map<string, boolean>();
  const isStable = (node: Node, bound: Set<string>): boolean => {
    const target = unwrap(node);
    switch (target.type) {
      case "Literal":
        return true;
      case "TemplateLiteral":
        return (target.expressions as Node[]).every((part) => isStable(part, bound));
      case "BinaryExpression":
        return (
          target.operator === "+" &&
          isStable(target.left as Node, bound) &&
          isStable(target.right as Node, bound)
        );
      case "Identifier":
        return bound.has(target.name);
      case "MemberExpression": {
        const name = target.computed ? null : propertyName(target.property as Node);
        return (
          unwrap(target.object as Node).type === "ThisExpression" &&
          name !== null &&
          readonlyFields.has(name)
        );
      }
      case "CallExpression": {
        if (!(target.arguments as Node[]).every((argument) => isStable(argument, bound))) {
          return false;
        }
        const callee = calleePath(target);
        if (callee === "path.join" || callee === "path.resolve") return true;
        const method = ownMethodCall(target);
        return method !== null && stableMethod(method);
      }
      default:
        return false;
    }
  };
  // A helper is stable when it only returns a stable expression of its
  // parameters, which the call site has already checked.
  const stableMethod = (name: string): boolean => {
    if (stableMethods.has(name)) return stableMethods.get(name)!;
    stableMethods.set(name, false);
    const implementations = membersByName.get(name) ?? [];
    const stable =
      implementations.length > 0 &&
      implementations.every((member) => {
        const returned = onlyReturned(member.fn);
        return returned !== null && isStable(returned, new Set(paramNames(member.fn)));
      });
    stableMethods.set(name, stable);
    return stable;
  };

  const describeLease = (wrapper: LeaseWrapper, call: CallExpression, file: ParsedFile): Lease => {
    const target =
      "param" in wrapper.target
        ? { node: unwrap(call.arguments[wrapper.target.param] as Node), file }
        : { node: unwrap(wrapper.target.node), file: wrapper.target.file };
    // A keyed lease does not exclude writers holding another key's.
    const keyed = !isStable(target.node, new Set());
    const store = storeMethodCall(target.node);
    if (!keyed && store && (target.node as Node & { arguments: Node[] }).arguments.length === 0) {
      return { name: store, keyed: false };
    }
    const name = text(target.file, target.node);
    return { name: keyed ? `keyed: ${name}` : name, keyed };
  };

  // Methods whose call returns a promise. Such a call on a write path must be
  // awaited or returned, or its write can land after the lease is released.
  const promiseMethods = new Map<string, boolean>();
  const returnsPromise = (name: string): boolean => {
    if (promiseMethods.has(name)) return promiseMethods.get(name)!;
    promiseMethods.set(name, true);
    const implementations = membersByName.get(name) ?? [];
    const result =
      implementations.length === 0
        ? !SYNCHRONOUS_PRIMITIVES.has(name)
        : implementations.some((member) => {
            const fn = member.fn as Node & { async?: boolean; returnType?: Node | null };
            if (fn.async) return true;
            if (fn.returnType) {
              return /\b(?:Promise|PromiseLike|any|unknown)\b/.test(
                text(member.file, fn.returnType),
              );
            }
            return returnedExpressions(fn).some((expression) => {
              const value = unwrap(expression);
              if (value.type === "NewExpression" || value.type === "AwaitExpression") return true;
              if (value.type !== "CallExpression") return false;
              const method = ownMethodCall(value);
              return method
                ? returnsPromise(method)
                : (calleePath(value)?.startsWith("Promise.") ?? false);
            });
          });
    promiseMethods.set(name, result);
    return result;
  };
  /** Why `call` may outlive its enclosing function, or `null` when it cannot. */
  const unsettled = (call: Node, ancestors: Node[], file: ParsedFile): string | null => {
    const method = ownMethodCall(call);
    if (!method || !returnsPromise(method) || settled(call, ancestors)) return null;
    return `${text(file, (call as CallExpression).callee as Node)}(...) at ${location(file, call)} is neither awaited nor returned, so it may finish after the lease is released`;
  };

  /** `kanbanFile` for `this.kanbanFile()`, else `null`. */
  function storeMethodCall(node: Node): string | null {
    const target = unwrap(node);
    return target.type === "CallExpression" ? ownMethodCall(target) : null;
  }

  // A method whose whole body is `return this.storeForFile(this.xFile())`
  // names the same store as `xFile`.
  const resolveStore = (node: Node, ancestors: Node[], depth = 0): string | null => {
    if (depth > 8) return null;
    const target = unwrap(node);
    const method = storeMethodCall(target);
    if (method) {
      const args = (target as Node & { arguments: Node[] }).arguments;
      if (method === "storeForFile" && args[0]) return resolveStore(args[0], ancestors, depth + 1);
      for (const member of membersByName.get(method) ?? []) {
        const statements = (member.fn as Node & { body: { body?: Node[] } }).body.body ?? [];
        const only = statements.length === 1 ? statements[0]! : null;
        if (only?.type === "ReturnStatement" && only.argument) {
          const returned = unwrap(only.argument as Node);
          if (storeMethodCall(returned) === "storeForFile") {
            return resolveStore(returned, [member.fn], depth + 1);
          }
        }
      }
      return method;
    }
    if (target.type === "Identifier") {
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const scope = ancestors[index]!;
        const statements = scope.type === "BlockStatement" ? (scope.body as Node[]) : [];
        for (const statement of statements) {
          if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
          for (const declarator of statement.declarations) {
            if (declarator.id.type === "Identifier" && declarator.id.name === target.name) {
              return declarator.init
                ? resolveStore(declarator.init as Node, ancestors.slice(0, index + 1), depth + 1)
                : null;
            }
          }
        }
      }
    }
    return null;
  };

  /** Leases taken between `ancestors`' innermost function and its class member. */
  const contextOf = (
    ancestors: Node[],
    file: ParsedFile,
  ): { leases: Lease[]; member: Member | null; problem?: string } => {
    const leases: Lease[] = [];
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const node = ancestors[index]!;
      if (!isFunction(node)) continue;
      const parent = ancestors[index - 1];
      if (
        (parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition") &&
        parent.value === node
      ) {
        const member =
          members.find((candidate) => candidate.node === parent) ??
          members.find((candidate) => candidate.fn === node) ??
          null;
        if (!member) {
          return {
            leases,
            member,
            problem: `inside a method of a nested class at ${location(file, parent)}`,
          };
        }
        return { leases, member };
      }
      if (parent?.type === "CallExpression" && (parent.arguments as Node[]).includes(node)) {
        const callee = calleePath(parent);
        if (callee && SYNCHRONOUS_CALLBACKS.has(callee)) continue;
        const name = ownMethodCall(parent);
        const wrapper = name ? leaseWrapper(name) : null;
        const leased = wrapper && (parent.arguments as Node[]).indexOf(node) === wrapper.operation;
        if (callee === "this.atomically" || leased) {
          const problem = unsettled(parent, ancestors.slice(0, index - 1), file);
          if (problem) return { leases, member: null, problem };
        }
        if (callee === "this.atomically") {
          // The scope commits its buffered writes when it ends, after any
          // lease taken inside it is released.
          if (leases.length > 0) {
            return {
              leases,
              member: null,
              problem: `inside a lease taken within this.atomically at ${location(file, parent)}, which commits after the lease is released`,
            };
          }
          continue;
        }
        if (leased) {
          leases.push(describeLease(wrapper, parent, file));
          continue;
        }
        return {
          leases,
          member: null,
          problem: `inside a callback of ${callee ?? text(file, parent.callee as Node)} at ${location(file, parent)}, which may run after the lease is released`,
        };
      }
      return {
        leases,
        member: null,
        problem: `inside a nested function at ${location(file, node)}, which may run after the lease is released`,
      };
    }
    return { leases, member: null, problem: "outside a class member" };
  };

  const insideAtomically = (ancestors: Node[]) =>
    ancestors.some(
      (node, index) =>
        isFunction(node) &&
        ancestors[index - 1]?.type === "CallExpression" &&
        calleePath(ancestors[index - 1]!) === "this.atomically",
    );

  // Methods that can run inside an `atomically` scope: everything called,
  // transitively, from an `atomically` callback.
  const atomicMethods = new Set<string>();
  const pending: string[] = [];
  for (const site of calls) {
    if (site.callee !== "this.atomically") continue;
    for (const argument of site.call.arguments) {
      walk(argument as Node, (node) => {
        const name = node.type === "CallExpression" ? ownMethodCall(node) : null;
        if (name) pending.push(name);
      });
    }
  }
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (atomicMethods.has(name) || PRIMITIVES.has(name)) continue;
    atomicMethods.add(name);
    for (const site of calls) {
      if (site.member.name !== name) continue;
      const callee = ownMethodCall(site.call);
      if (callee) pending.push(callee);
    }
  }

  /** Paths from `call` (a write, or a call of a helper that writes) to its leases. */
  const pathsFrom = (
    call: Node,
    ancestors: Node[],
    file: ParsedFile,
    via: string[],
    seen: Set<string>,
  ): WritePath[] => {
    const notAwaited = unsettled(call, ancestors, file);
    if (notAwaited) return [{ leases: [], via, entry: null, problem: notAwaited }];
    const context = contextOf(ancestors, file);
    if (context.problem) {
      return [{ leases: context.leases, via, entry: null, problem: context.problem }];
    }
    const member = context.member!;
    if (context.leases.some((lease) => !lease.keyed) || member.accessibility === "public") {
      return [{ leases: context.leases, via, entry: member }];
    }
    if (seen.has(member.name)) {
      return [
        { leases: context.leases, via, entry: member, problem: `recursion through ${member.name}` },
      ];
    }
    const out: WritePath[] = [];
    for (const reference of valueReferences.get(member.name) ?? []) {
      out.push({
        leases: context.leases,
        via,
        entry: member,
        problem: `${member.name} is used without being called at ${location(reference.member.file, reference.node)}`,
      });
    }
    const callers = callersByMethod.get(member.name) ?? [];
    if (callers.length === 0) {
      out.push({
        leases: context.leases,
        via,
        entry: member,
        problem: `${member.name} has no caller`,
      });
    }
    for (const caller of callers) {
      const step = `${member.name} ← ${caller.member.className}.${caller.member.name} (${location(caller.member.file, caller.call)})`;
      for (const outer of pathsFrom(
        caller.call,
        caller.ancestors,
        caller.member.file,
        [...via, step],
        new Set([...seen, member.name]),
      )) {
        out.push({ ...outer, leases: [...context.leases, ...outer.leases] });
      }
    }
    return out;
  };

  const sites: WriteSite[] = [];
  for (const site of calls) {
    let kind = WRITES.get(site.callee);
    if (!kind) continue;
    const file = site.member.file;
    const where = `${location(file, site.call)} ${site.member.className}.${site.member.name}`;
    const call = site.callee.replace(/^this\./, "");
    const argument = site.call.arguments[0] as Node | undefined;
    const store = argument ? resolveStore(argument, site.ancestors) : null;
    if (!store) {
      violations.push(`${where}: cannot resolve the store written by ${call}`);
      continue;
    }
    let reason: string | undefined;
    if (kind === "transactional") {
      if (insideAtomically(site.ancestors) || atomicMethods.has(site.member.name)) {
        kind = "whole";
        reason = "buffered by atomically and committed whole";
      }
    }
    sites.push({
      location: where,
      member: `${site.member.className}.${site.member.name}`,
      call,
      store,
      kind,
      reason,
      paths: kind === "whole" ? pathsFrom(site.call, site.ancestors, file, [], new Set()) : [],
    });
  }

  const stores = new Map<string, StoreSummary>();
  for (const store of new Set(sites.map((site) => site.store))) {
    const ofStore = sites.filter((site) => site.store === store);
    const whole = ofStore.filter((site) => site.kind === "whole");
    const transactional = ofStore.filter((site) => site.kind === "transactional");
    const leaseSets: Array<Set<string>> = [];
    for (const site of whole) {
      for (const writePath of site.paths) {
        const route = writePath.via.length > 0 ? ` via ${writePath.via.join(" ← ")}` : "";
        const label = `${site.location}: ${site.call}(${store})${site.reason ? ` (${site.reason})` : ""}${route}`;
        if (writePath.problem) {
          violations.push(`${label}: ${writePath.problem}`);
          continue;
        }
        const storeWide = writePath.leases
          .filter((lease) => !lease.keyed)
          .map((lease) => lease.name);
        if (storeWide.length === 0) {
          const entry = writePath.entry;
          const held = writePath.leases.map((lease) => lease.name).join(", ") || "none";
          violations.push(
            `${label}: no store-wide lease reaches this write from ${entry ? `${entry.className}.${entry.name}` : "its caller"} (leases held: ${held})`,
          );
          continue;
        }
        leaseSets.push(new Set(storeWide));
      }
    }
    // Two writers exclude each other only through a lease both hold.
    const common = leaseSets.length
      ? leaseSets.reduce((shared, held) => new Set([...shared].filter((name) => held.has(name))))
      : null;
    if (common !== null && common.size === 0) {
      const detail = whole
        .flatMap((site) =>
          site.paths.map(
            (writePath) =>
              `${site.location} [${writePath.leases.map((lease) => lease.name).join(", ")}]`,
          ),
        )
        .join("; ");
      violations.push(`${store}: whole-value writers share no lease (${detail})`);
    }
    if (whole.length > 0 && transactional.length > 0) {
      violations.push(
        `${store}: written both whole (${whole.map((site) => site.location).join(", ")}) and by unleased transactions (${transactional.map((site) => site.location).join(", ")}); the whole-value write overwrites rows the transactions commit`,
      );
    }
    stores.set(store, {
      kind:
        whole.length > 0 && transactional.length > 0
          ? "mixed"
          : whole.length > 0
            ? "whole"
            : "transactional",
      leases: common ? [...common].sort() : [],
      sites: ofStore.length,
      paths: whole.reduce((total, site) => total + site.paths.length, 0),
    });
  }

  return { chain: chain.map((info) => info.name), sites, stores, violations };
}

function readStorageSources(): SourceFile[] {
  return readdirSync(coreDir)
    .filter((name) => /^storage.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => ({
      file: path.relative(repoRoot, path.join(coreDir, name)),
      source: readFileSync(path.join(coreDir, name), "utf8"),
    }));
}

function backendSourceFiles(dir = backendSrc): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...backendSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

let storageAnalysis: Analysis | undefined;
function analyzeStorageService(): Analysis {
  storageAnalysis ??= analyzeStorageWriters(readStorageSources(), { rootClass: "StorageService" });
  return storageAnalysis;
}

describe("StorageService store writers", () => {
  test("every whole-value write holds a lease that every writer of its store holds", () => {
    expect(analyzeStorageService().violations).toEqual([]);
  });

  test("the scan covers the chain, its lease wrappers and its helpers", () => {
    const { chain, stores } = analyzeStorageService();
    expect(chain.at(-1)).toBe("StorageBase");
    // Leased stores, including one helper reached from many callers and a
    // store held under another store's lease.
    expect(stores.get("kanbanFile")).toMatchObject({ kind: "whole", leases: ["kanbanFile"] });
    expect(stores.get("environmentsFile")).toMatchObject({
      kind: "whole",
      leases: ["environmentsFile"],
    });
    expect(stores.get("environmentsFile")!.paths).toBeGreaterThan(10);
    expect(stores.get("projectRemovalFencesFile")).toMatchObject({
      kind: "whole",
      leases: ["environmentsFile"],
    });
    expect(stores.get("publicOperationIndexFile")).toMatchObject({
      kind: "whole",
      leases: ['path.join(this.publicOperationsDir(), "store")'],
    });
    expect(stores.get("previewSettingsFile")).toMatchObject({
      kind: "whole",
      leases: ["previewSettingsFile"],
    });
    // The machine profile's compare-and-swap edit and its create-once read
    // share one lease, through a private helper.
    expect(stores.get("backendProfileFile")).toMatchObject({
      kind: "whole",
      leases: ["backendProfileFile"],
      paths: 3,
    });
    expect(stores.get("linearAuthFile")).toMatchObject({
      kind: "whole",
      leases: ["linearAuthFile"],
    });
    // Transactional stores, including a raw database writer resolved through
    // `buildPipelineStore()`.
    for (const store of [
      "sessionsFile",
      "featurePlansFile",
      "nativeAgentSessionsFile",
      "multiReviewsFile",
      "buildPipelinesFile",
    ]) {
      expect(stores.get(store)?.kind).toBe("transactional");
    }
  });

  test("no backend class outside the chain calls the store write primitives", () => {
    const { chain } = analyzeStorageService();
    const allowed = new Set(chain);
    const pattern =
      /\b(?:this|super)\.(?:saveJson|saveSensitiveJson|deleteStore|updateStore|updateStoreRow)\s*[<(]/;
    const outside: string[] = [];
    for (const full of backendSourceFiles()) {
      const source = readFileSync(full, "utf8");
      if (!pattern.test(source)) continue;
      const file = parse({ file: path.relative(repoRoot, full), source });
      walk(file.program, (node, ancestors) => {
        const callee = node.type === "CallExpression" ? calleePath(node) : null;
        if (
          !callee ||
          !/^this\.(?:saveJson|saveSensitiveJson|deleteStore|updateStore|updateStoreRow)$/.test(
            callee,
          )
        ) {
          return;
        }
        const owner = ancestors.findLast(
          (ancestor) => ancestor.type === "ClassDeclaration" || ancestor.type === "ClassExpression",
        );
        const name =
          owner?.type === "ClassDeclaration" || owner?.type === "ClassExpression"
            ? (owner.id?.name ?? null)
            : null;
        if (!name || !allowed.has(name)) {
          outside.push(`${file.file}:${lineOf(file, node.start)} ${name ?? "(no class)"}`);
        }
      });
    }
    // A class that writes stores outside the chain is invisible to the guard
    // above; extend the scan to it (for example when a repository is extracted).
    expect(outside).toEqual([]);
  });

  test("only StorageBase holds the StorageContext", () => {
    // Its store primitives are scanned through StorageBase's forwarders. A
    // class that takes a StorageContext (an extracted repository) writes
    // through `this.context`, which the scan does not follow yet: teach the
    // scan that class and those names before allowing it here.
    const allowed = new Set(
      ["storage-base.ts", "storage-context.ts", "storage-changes.ts"].map((name) =>
        path.relative(repoRoot, path.join(coreDir, name)),
      ),
    );
    const holders: string[] = [];
    for (const full of backendSourceFiles()) {
      const source = readFileSync(full, "utf8");
      if (!source.includes("StorageContext")) continue;
      const file = parse({ file: path.relative(repoRoot, full), source });
      walk(file.program, (node) => {
        if (
          node.type === "Identifier" &&
          node.name === "StorageContext" &&
          !allowed.has(file.file)
        ) {
          holders.push(`${file.file}:${lineOf(file, node.start)}`);
        }
      });
    }
    expect(holders).toEqual([]);
  });
});

describe("store writer analysis", () => {
  const base = `
    export abstract class Base {
      protected readonly dataDir: string = "/data";
      protected currentKey = "k";
      protected file(name: string): string { return path.join(this.dataDir, name); }
      protected aFile(): string { return this.file("a.json"); }
      protected keyedTarget(): string { return this.file(path.join("keys", this.currentKey)); }
      protected bFile(): string { return this.file("b.json"); }
      protected bStore(): string { return this.storeForFile(this.bFile())!; }
      protected enqueueA<T>(operation: () => Promise<T>): Promise<T> {
        return this.serializeMutation(this.aFile(), "a storage", operation);
      }
      protected enqueueOn<T>(target: string, operation: () => Promise<T>): Promise<T> {
        return this.serializeMutation(target, "any storage", operation);
      }
      protected enqueueViaA<T>(operation: () => Promise<T>): Promise<T> {
        return this.enqueueA(operation);
      }
      protected enqueueKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
        const digest = hash(key);
        return this.serializeMutation(this.file(path.join("keys", digest)), "key", operation);
      }
    }
  `;
  const analyze = (body: string) =>
    analyzeStorageWriters(
      [{ file: "fixture.ts", source: `${base}\nexport class Store extends Base {\n${body}\n}` }],
      { rootClass: "Store" },
    );

  test("accepts leased writes through wrappers, parameter targets and helpers", () => {
    const result = analyze(`
      async direct() { return this.enqueueA(async () => { await this.saveJson(this.aFile(), 1); }); }
      async nested() { return this.enqueueViaA(async () => this.write(2)); }
      async onTarget() { return this.enqueueOn(this.aFile(), async () => { await this.write(3); }); }
      private async write(value: number) { await this.saveSensitiveJson(this.aFile(), value); }
      async rows() { this.database.transaction(() => { this.database.updateStoreRow(this.bStore(), "k", () => ({ result: 1 })); }); }
    `);
    expect(result.violations).toEqual([]);
    expect(result.stores.get("aFile")).toMatchObject({
      kind: "whole",
      leases: ["aFile"],
      paths: 3,
    });
    expect(result.stores.get("bFile")).toMatchObject({ kind: "transactional" });
  });

  test("rejects an unleased write and a helper with an unleased caller", () => {
    const result = analyze(`
      async save() { await this.saveJson(this.aFile(), 1); }
      async leased() { return this.enqueueA(async () => this.write(2)); }
      async unleased() { await this.write(3); }
      private async write(value: number) { await this.saveJson(this.bFile(), value); }
    `);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toContain(
      "no store-wide lease reaches this write from Store.save",
    );
    expect(result.violations[1]).toContain("write ← Store.unleased");
  });

  test("rejects a write held only by one key's lease", () => {
    const result = analyze(`
      async save(key: string) { return this.enqueueKey(key, async () => { await this.saveJson(this.aFile(), 1); }); }
    `);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('keyed: this.file(path.join("keys", digest))');
  });

  test("rejects writers of one store under different leases", () => {
    const result = analyze(`
      async one() { return this.enqueueA(async () => { await this.saveJson(this.bFile(), 1); }); }
      async two() { return this.enqueueOn(this.bFile(), async () => { await this.saveJson(this.bFile(), 2); }); }
    `);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("bFile: whole-value writers share no lease");
  });

  test("rejects a store written both whole and by transactions", () => {
    const result = analyze(`
      async save() { return this.enqueueA(async () => { await this.saveJson(this.aFile(), 1); }); }
      async touch() { this.updateStore(this.aFile(), () => 0, () => undefined); }
    `);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("aFile: written both whole");
  });

  test("treats a transaction inside atomically as a whole-value write", () => {
    const result = analyze(`
      async both() { return this.enqueueA(async () => this.atomically(async () => { this.bump(); })); }
      async plain() { this.updateStore(this.bFile(), () => 0, () => undefined); }
      private bump() { this.updateStore(this.bFile(), () => 0, () => undefined); }
    `);
    expect(result.sites.find((site) => site.member === "Store.bump")).toMatchObject({
      kind: "whole",
      reason: "buffered by atomically and committed whole",
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("bFile: written both whole");
  });

  test("rejects a write in a callback that can outlive the lease", () => {
    const result = analyze(`
      async save() {
        return this.enqueueA(async () => {
          [1, 2].forEach(async (value) => { await this.saveJson(this.aFile(), value); });
        });
      }
    `);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("inside a callback of [1, 2].forEach");
  });

  test("rejects a helper passed around as a value", () => {
    const result = analyze(`
      async save() { return this.enqueueA(async () => { const write = this.write; await write(1); }); }
      private async write(value: number) { await this.saveJson(this.aFile(), value); }
    `);
    expect(result.violations.join("\n")).toContain("write is used without being called");
  });

  test("rejects a store argument it cannot name", () => {
    const result = analyze(`
      async save(file: string) { return this.enqueueA(async () => { await this.saveJson(file, 1); }); }
    `);
    expect(result.violations).toEqual([
      expect.stringMatching(
        /^fixture\.ts:\d+ Store\.save: cannot resolve the store written by saveJson$/,
      ),
    ]);
  });

  test("accepts writes and helpers whose result is awaited or returned", () => {
    const result = analyze(`
      async awaited() { return this.enqueueA(async () => { await this.write(1); }); }
      async returned() { return this.enqueueA(async () => { return this.write(2); }); }
      async body() { return this.enqueueA(async () => this.write(3)); }
      async both() { return this.enqueueA(async () => { await Promise.all([this.write(4), this.write(5)]); }); }
      async scoped() { return this.enqueueA(async () => { await this.atomically(async () => { await this.write(6); }); }); }
      private async write(value: number) { await waitForExternalWork(); await this.saveJson(this.aFile(), value); }
    `);
    expect(result.violations).toEqual([]);
    expect(result.stores.get("aFile")).toMatchObject({ leases: ["aFile"], paths: 6 });
  });

  test("rejects a helper or write whose result the lease callback drops", () => {
    for (const call of [
      "this.write(1);",
      "void this.write(1);",
      "const pending = this.write(1);",
    ]) {
      const result = analyze(`
        async save() { return this.enqueueA(async () => { ${call} }); }
        private async write(value: number) { await waitForExternalWork(); await this.saveJson(this.aFile(), value); }
      `);
      expect(result.violations).toEqual([
        expect.stringContaining("this.write(...) at fixture.ts:"),
      ]);
      expect(result.violations[0]).toContain("is neither awaited nor returned");
    }
    for (const body of [
      // Inside the callback, inside a helper, and an atomically scope that commits later.
      `async save() { return this.enqueueA(async () => { this.saveJson(this.aFile(), 1); }); }`,
      `async save() { return this.enqueueA(async () => this.write()); }
       private async write() { await waitForExternalWork(); this.saveJson(this.aFile(), 1); }`,
      `async save() { return this.enqueueA(async () => { void this.atomically(async () => { await this.saveJson(this.aFile(), 1); }); }); }`,
    ]) {
      const result = analyze(body);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain("is neither awaited nor returned");
    }
  });

  test("rejects a lease taken inside atomically", () => {
    const result = analyze(`
      async save() { return this.atomically(async () => this.enqueueA(async () => { await this.saveJson(this.aFile(), 1); })); }
    `);
    expect(result.violations).toEqual([
      expect.stringContaining("inside a lease taken within this.atomically"),
    ]);
  });

  test("classifies super calls of the store primitives like this calls", () => {
    for (const call of ["super.saveJson", "super.saveSensitiveJson", "super.deleteStore"]) {
      const result = analyze(`async save() { await ${call}(this.aFile(), 1); }`);
      expect(result.violations).toEqual([
        expect.stringContaining("no store-wide lease reaches this write from Store.save"),
      ]);
    }
    for (const call of [
      "super.updateStore(this.aFile(), () => 0, () => undefined)",
      'super.updateStoreRow(this.aFile(), "k", () => ({ result: 1 }))',
    ]) {
      const result = analyze(`
        async save() { return this.enqueueA(async () => { await super.saveJson(this.aFile(), 1); }); }
        async touch() { ${call}; }
      `);
      expect(result.violations).toEqual([expect.stringContaining("aFile: written both whole")]);
    }
  });

  test("rejects a lease wrapper that can run its operation without the lease", () => {
    for (const wrapper of [
      `if (this.currentKey === "skip") return operation();
       return this.serializeMutation(this.aFile(), "a", operation);`,
      `void operation();
       return this.serializeMutation(this.aFile(), "a", operation);`,
    ]) {
      const result = analyze(`
        protected enqueueMaybe<T>(operation: () => Promise<T>): Promise<T> { ${wrapper} }
        async save() { return this.enqueueMaybe(async () => { await this.saveJson(this.aFile(), 1); }); }
      `);
      expect(result.violations).toEqual([
        expect.stringContaining("inside a callback of this.enqueueMaybe"),
      ]);
    }
  });

  test("treats a lease target as store-wide only when every caller names the same lease", () => {
    for (const target of ["this.keyedTarget()", "this.file(this.currentKey)"]) {
      const result = analyze(`
        async save() { return this.serializeMutation(${target}, "k", async () => { await this.saveJson(this.aFile(), 1); }); }
      `);
      expect(result.violations).toEqual([expect.stringContaining(`keyed: ${target}`)]);
    }
    const fixed = analyze(`
      protected fixedTarget(): string { return path.join(this.dataDir, "fixed", \`\${"store"}\`); }
      async save() { return this.serializeMutation(this.fixedTarget(), "f", async () => { await this.saveJson(this.aFile(), 1); }); }
    `);
    expect(fixed.violations).toEqual([]);
    expect(fixed.stores.get("aFile")).toMatchObject({ leases: ["fixedTarget"] });
  });

  test("follows #private methods and fails writes it cannot follow", () => {
    const leased = analyze(`
      async save() { return this.enqueueA(async () => this.#write()); }
      async #write() { await this.saveJson(this.aFile(), 1); }
    `);
    expect(leased.violations).toEqual([]);
    expect(leased.stores.get("aFile")).toMatchObject({ leases: ["aFile"] });

    const unleased = analyze(`
      async save() { await this.#write(); }
      async #write() { await this.saveJson(this.aFile(), 1); }
    `);
    expect(unleased.violations).toEqual([expect.stringContaining("#write ← Store.save")]);

    const computed = analyze(`
      async save() { return this.enqueueA(async () => this["write"]()); }
      async ["write"]() { await this.saveJson(this.aFile(), 1); }
    `);
    expect(computed.violations).toEqual([
      expect.stringContaining('no store-wide lease reaches this write from Store.["write"]'),
    ]);

    const initializer = analyze(`pending = this.saveJson(this.aFile(), 1);`);
    expect(initializer.violations).toEqual([
      expect.stringContaining("saveJson outside any method the analysis can follow"),
    ]);
  });

  test("lets only the base's forwarders reach the StorageContext's writers", () => {
    const sources = (base: string, layer: string) => [
      {
        file: "fixture.ts",
        source: `
          export abstract class Base {
            protected readonly dataDir: string = "/data";
            private readonly context = new StorageContext();
            protected file(name: string): string { return path.join(this.dataDir, name); }
            protected aFile(): string { return this.file("a.json"); }
            protected async saveJson(file: string, value: unknown): Promise<void> {
              return this.context.saveJson(file, value);
            }
            protected serializeMutation<T>(target: string, label: string, operation: () => Promise<T>): Promise<T> {
              return this.context.serialize(target, label, operation);
            }
            protected announce(id: string): void { this.context.changes.announce(id); }
            ${base}
          }
          export class Store extends Base {
            async save() { return this.serializeMutation(this.aFile(), "a", async () => { await this.saveJson(this.aFile(), 1); }); }
            ${layer}
          }`,
      },
    ];
    const run = (base: string, layer: string) =>
      analyzeStorageWriters(sources(base, layer), { rootClass: "Store" }).violations;

    expect(run("", "")).toEqual([]);
    expect(run("", `async direct() { await this.context.saveJson(this.aFile(), 2); }`)).toEqual([
      expect.stringContaining("Store: reaches this.context directly"),
    ]);
    expect(
      run(`protected async sneak() { await this.context.saveJson(this.aFile(), 2); }`, ""),
    ).toEqual([expect.stringContaining("this.context.saveJson outside the saveJson forwarder")]);
    expect(
      run(
        `protected async lease<T>(op: () => Promise<T>) { return this.context.serialize("x", "x", op); }`,
        "",
      ),
    ).toEqual([
      expect.stringContaining("this.context.serialize outside the serializeMutation forwarder"),
    ]);
    for (const member of [
      `protected handle() { return this.context; }`,
      `protected swap(other: StorageContext) { (this as any).context = other; }`,
    ]) {
      expect(run(member, "")).toEqual([expect.stringContaining("uses this.context as a value")]);
    }
    // Only the constructor may assign it.
    expect(run(`constructor() { (this as any).context = new StorageContext(); }`, "")).toEqual([]);
  });

  test("treats a store deletion as a whole-value write", () => {
    const unleased = analyze(`async clear() { await this.deleteStore(this.aFile()); }`);
    expect(unleased.violations).toEqual([
      expect.stringContaining("no store-wide lease reaches this write from Store.clear"),
    ]);

    const mixed = analyze(`
      async clear() { return this.enqueueA(async () => this.deleteStore(this.aFile())); }
      async touch() { this.updateStore(this.aFile(), () => 0, () => undefined); }
    `);
    expect(mixed.violations).toEqual([expect.stringContaining("aFile: written both whole")]);

    const apart = analyze(`
      async save() { return this.enqueueA(async () => { await this.saveJson(this.bFile(), 1); }); }
      async clear() { return this.enqueueOn(this.bFile(), async () => this.deleteStore(this.bFile())); }
    `);
    expect(apart.violations).toEqual([
      expect.stringContaining("bFile: whole-value writers share no lease"),
    ]);
  });
});
