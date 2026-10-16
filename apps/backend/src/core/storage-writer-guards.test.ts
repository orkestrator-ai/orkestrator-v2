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
 * A whole-value write is `saveJson`, `saveSensitiveJson`, a raw
 * `database.writeStore*`, or an `updateStore`/`updateStoreRow` reached from
 * inside `atomically`, which buffers the value and commits it whole.
 *
 * Code between the lease callback and the write may not start another
 * function (a `forEach` callback, a timer): nothing proves it still runs while
 * the lease is held. Store arguments must name their store
 * (`this.kanbanFile()`), so the analysis can group writers by store.
 */

const coreDir = import.meta.dir;
const backendSrc = path.resolve(coreDir, "..");
const repoRoot = path.resolve(backendSrc, "../../..");

type WriteKind = "whole" | "transactional";

const WRITES = new Map<string, WriteKind>([
  ["this.saveJson", "whole"],
  ["this.saveSensitiveJson", "whole"],
  ["this.updateStore", "transactional"],
  ["this.updateStoreRow", "transactional"],
  ["this.database.writeStore", "whole"],
  ["this.database.writeStoreInTransaction", "whole"],
  ["this.database.updateStore", "transactional"],
  ["this.database.updateStoreRow", "transactional"],
]);

/** The primitives themselves (in `StorageBase`); their bodies are not call sites. */
const PRIMITIVES = new Set([
  "saveJson",
  "saveSensitiveJson",
  "saveStore",
  "updateStore",
  "updateStoreRow",
  "atomically",
  "deleteStore",
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
  if (target.type === "ThisExpression") return "this";
  if (target.type === "Super") return "super";
  if (target.type === "Identifier") return target.name;
  if (target.type === "MemberExpression" && !target.computed) {
    const object = memberPath(target.object as Node);
    return object && target.property.type === "Identifier"
      ? `${object}.${target.property.name}`
      : null;
  }
  return null;
}

function calleePath(call: Node): string | null {
  return call.type === "CallExpression" ? memberPath(call.callee as Node) : null;
}

/** The method name of a `this.name(...)` or `super.name(...)` call. */
function ownMethodCall(call: Node): string | null {
  const callee = calleePath(call);
  const match = callee ? /^(?:this|super)\.([A-Za-z_$][\w$]*)$/.exec(callee) : null;
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
  for (const info of chain) {
    const body = (info.node as Node & { body: { body: Node[] } }).body.body;
    for (const node of body) {
      if (node.type !== "MethodDefinition" && node.type !== "PropertyDefinition") continue;
      const fn = node.value as Node | null;
      if (!fn || !isFunction(fn) || node.key.type !== "Identifier") continue;
      members.push({
        className: info.name,
        name: node.key.name,
        accessibility: node.accessibility ?? "public",
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
        if (node.property.type !== "Identifier") return;
        const name = node.property.name;
        valueReferences.set(name, [...(valueReferences.get(name) ?? []), { member, node }]);
      },
      [classNode],
    );
  }
  const callersByMethod = new Map<string, CallSite[]>();
  for (const site of calls) {
    const name = ownMethodCall(site.call);
    if (name) callersByMethod.set(name, [...(callersByMethod.get(name) ?? []), site]);
  }

  const location = (file: ParsedFile, node: Node) => `${file.file}:${lineOf(file, node.start)}`;

  // A lease wrapper runs one of its arguments (`operation`) under a lease on
  // `target`, which is either one of its parameters or an expression of its own.
  type LeaseWrapper = {
    operation: number;
    target: { param: number } | { node: Node; file: ParsedFile };
  };
  const wrappers = new Map<string, LeaseWrapper | null>([
    ["serializeMutation", { operation: 2, target: { param: 0 } }],
  ]);
  const leaseWrapper = (name: string): LeaseWrapper | null => {
    if (wrappers.has(name)) return wrappers.get(name)!;
    wrappers.set(name, null);
    for (const member of membersByName.get(name) ?? []) {
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
        const operationParam =
          operation?.type === "Identifier" ? params.indexOf(operation.name) : -1;
        if (operationParam < 0) continue;
        let target = wrapper.target;
        if ("param" in target) {
          const argument = node.arguments[target.param] as Node;
          const targetParam = argument.type === "Identifier" ? params.indexOf(argument.name) : -1;
          target =
            targetParam >= 0 ? { param: targetParam } : { node: argument, file: member.file };
        }
        const found: LeaseWrapper = { operation: operationParam, target };
        wrappers.set(name, found);
        return found;
      }
    }
    return null;
  };

  const describeLease = (wrapper: LeaseWrapper, call: CallExpression, file: ParsedFile): Lease => {
    const target =
      "param" in wrapper.target
        ? { node: unwrap(call.arguments[wrapper.target.param] as Node), file }
        : { node: unwrap(wrapper.target.node), file: wrapper.target.file };
    const store = storeMethodCall(target.node);
    if (store && (target.node as Node & { arguments: Node[] }).arguments.length === 0) {
      return { name: store, keyed: false };
    }
    // A target built from a local or parameter names one key's lease, which
    // does not exclude writers holding another key's.
    const keyed = freeIdentifiers(target.node).some((name) => name !== "path");
    const name = text(target.file, target.node);
    return { name: keyed ? `keyed: ${name}` : name, keyed };
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
        return { leases, member };
      }
      if (parent?.type === "CallExpression" && (parent.arguments as Node[]).includes(node)) {
        const callee = calleePath(parent);
        if (callee === "this.atomically" || (callee && SYNCHRONOUS_CALLBACKS.has(callee))) continue;
        const name = ownMethodCall(parent);
        const wrapper = name ? leaseWrapper(name) : null;
        if (wrapper && (parent.arguments as Node[]).indexOf(node) === wrapper.operation) {
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

  const pathsFrom = (
    ancestors: Node[],
    file: ParsedFile,
    via: string[],
    seen: Set<string>,
  ): WritePath[] => {
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

  const violations: string[] = [];
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
      paths: kind === "whole" ? pathsFrom(site.ancestors, file, [], new Set()) : [],
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
      /\b(?:this|super)\.(?:saveJson|saveSensitiveJson|updateStore|updateStoreRow)\s*[<(]/;
    const outside: string[] = [];
    for (const full of backendSourceFiles()) {
      const source = readFileSync(full, "utf8");
      if (!pattern.test(source)) continue;
      const file = parse({ file: path.relative(repoRoot, full), source });
      walk(file.program, (node, ancestors) => {
        const callee = node.type === "CallExpression" ? calleePath(node) : null;
        if (
          !callee ||
          !/^(?:this|super)\.(?:saveJson|saveSensitiveJson|updateStore|updateStoreRow)$/.test(
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
});

describe("store writer analysis", () => {
  const base = `
    export abstract class Base {
      protected aFile(): string { return this.file("a.json"); }
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
});
