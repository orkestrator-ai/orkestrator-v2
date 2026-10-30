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
 * take none. This test parses `StorageService` and every class it reaches
 * through a typed field (its repositories, `StorageRepositories`,
 * `StorageFiles`) and proves, per store:
 *
 * 1. every whole-value write runs inside a store-wide lease callback
 *    (`StorageContext.serialize` or a wrapper that hands it its `operation`),
 *    directly or through helpers whose every caller does;
 * 2. all whole-value writers of one store share at least one lease;
 * 3. no store has both whole-value and transactional writers.
 *
 * A call is resolved through the declared types of the fields it goes through:
 * `this.repos.projects.saveEnvironments()` is `ProjectsRepository`'s method,
 * `this.context.saveJson()` is the `StorageContext` primitive. A whole-value
 * write is `saveJson`, `saveSensitiveJson`, `deleteStore`, a raw
 * `database.writeStore*`/`deleteStore*`, or an `updateStore`/`updateStoreRow`
 * reached from inside `atomically`, which buffers the value and commits it
 * whole.
 *
 * The entry points are the public methods of `StorageService` and the
 * members its public area fields pick (`readonly kanban: KanbanStorage`, where
 * `KanbanStorage = Pick<KanbanRepository, ...>`). Nothing else outside the
 * storage files reaches a repository, so any other repository method,
 * whatever its TypeScript visibility, is followed to every caller. A public
 * field of the facade that is not such a `Pick` fails the scan. Code
 * between the lease callback and the write may not start another function (a
 * `forEach` callback, a timer), and every asynchronous call on the way (the
 * write, each helper, `atomically`) must be awaited or returned: nothing else
 * proves it still runs while the lease is held. A lease wrapper must hand its
 * `operation` to the lease and use it nowhere else. A lease is store-wide only
 * when its target is the same string for every caller (literals, readonly
 * fields, `path` joins and helpers built from those). A write in a member the
 * analysis cannot follow fails. Store arguments must name their store
 * (`this.files.kanbanFile()`), so the analysis can group writers by store.
 */

export const coreDir = import.meta.dir;
const backendSrc = path.resolve(coreDir, "..");
export const repoRoot = path.resolve(backendSrc, "../../..");

type WriteKind = "whole" | "transactional";

/**
 * What a call of a member of a class the analysis does not read means. These
 * classes implement the store primitives; scanned classes only call them.
 */
type Primitive =
  | { kind: "write"; write: WriteKind }
  | { kind: "atomically" }
  | { kind: "lease" }
  | { kind: "path" }
  | { kind: "store-for-file" }
  | { kind: "synchronous-callback" }
  | { kind: "other"; async: boolean };

const PRIMITIVES = new Map<string, Primitive>([
  ["StorageContext.saveJson", { kind: "write", write: "whole" }],
  ["StorageContext.saveSensitiveJson", { kind: "write", write: "whole" }],
  ["StorageContext.deleteStore", { kind: "write", write: "whole" }],
  ["StorageContext.updateStore", { kind: "write", write: "transactional" }],
  ["StorageContext.updateStoreRow", { kind: "write", write: "transactional" }],
  ["StorageContext.atomically", { kind: "atomically" }],
  ["StorageContext.serialize", { kind: "lease" }],
  ["StorageContext.file", { kind: "path" }],
  ["StorageContext.storeForFile", { kind: "store-for-file" }],
  ["StorageContext.loadJson", { kind: "other", async: true }],
  ["StorageContext.loadJsonCached", { kind: "other", async: true }],
  ["StorageContext.acquireLease", { kind: "other", async: true }],
  ["StorageContext.storeExists", { kind: "other", async: true }],
  ["StorageContext.scrubSensitiveJsonBackups", { kind: "other", async: true }],
  ["StorageContext.transformSensitiveJsonBackups", { kind: "other", async: true }],
  ["StorageDatabase.writeStore", { kind: "write", write: "whole" }],
  ["StorageDatabase.writeStoreInTransaction", { kind: "write", write: "whole" }],
  ["StorageDatabase.deleteStore", { kind: "write", write: "whole" }],
  ["StorageDatabase.deleteStoreInTransaction", { kind: "write", write: "whole" }],
  ["StorageDatabase.updateStore", { kind: "write", write: "transactional" }],
  ["StorageDatabase.updateStoreRow", { kind: "write", write: "transactional" }],
  ["StorageDatabase.transaction", { kind: "synchronous-callback" }],
]);

/** Fields of the primitive classes, so `this.context.database.writeStore` resolves. */
const PRIMITIVE_FIELDS = new Map<string, Map<string, { type: string | null; readonly: boolean }>>([
  [
    "StorageContext",
    new Map([
      ["dataDir", { type: null, readonly: true }],
      ["database", { type: "StorageDatabase", readonly: false }],
      ["changes", { type: "StorageChanges", readonly: true }],
    ]),
  ],
  ["StorageDatabase", new Map()],
  ["StorageChanges", new Map()],
]);

type SourceFile = { file: string; source: string };

type ParsedFile = SourceFile & { program: Node; lineStarts: number[] };

type Field = {
  type: string | null;
  readonly: boolean;
  accessibility?: "public" | "protected" | "private";
  /** A `this.x` path the field is initialised from, when it has one. */
  from?: string | null;
};

type ClassInfo = {
  name: string;
  superName: string | null;
  node: Node;
  file: ParsedFile;
  fields: Map<string, Field>;
};

type Member = {
  className: string;
  name: string;
  /** `ClassName.name`: members are identified per class. */
  key: string;
  accessibility: "public" | "protected" | "private";
  node: Node;
  fn: Node;
  file: ParsedFile;
};

type CallSite = { call: CallExpression; ancestors: Node[]; member: Member };

type Resolved = { member: Member } | { primitive: string; info: Primitive | null } | null;

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
  /** Every class the scan reads, the root first. */
  classes: string[];
  /**
   * The root's area fields (`kanban`) and the members their `Pick` type
   * names (`KanbanRepository.addKanbanTask`): entry points like the root's
   * own public methods.
   */
  areas: Map<string, string[]>;
  /**
   * Each store's database name by the helper that names it (`kanbanFile` →
   * `kanban`). `*` stands for a part a parameter supplies.
   */
  storeNames: Map<string, string>;
  sites: WriteSite[];
  stores: Map<string, StoreSummary>;
  violations: string[];
};

/**
 * Trees already parsed, by file. One test file runs several scans over the
 * same sources; each parses a file at most once. A source a test rewrote has
 * different text and is parsed afresh.
 */
const parsedFiles = new Map<string, ParsedFile>();

export function parse(source: SourceFile): ParsedFile {
  const cached = parsedFiles.get(source.file);
  if (cached?.source === source.source) return cached;
  const parsed = parseSource(source);
  parsedFiles.set(source.file, parsed);
  return parsed;
}

function parseSource(source: SourceFile): ParsedFile {
  const { program, errors } = parseSync(source.file, source.source);
  // A file that does not parse must not pass by yielding a partial tree.
  if (errors.length > 0) throw new Error(`${source.file}: ${errors[0]!.message}`);
  const lineStarts = [0];
  for (let index = 0; index < source.source.length; index += 1) {
    if (source.source[index] === "\n") lineStarts.push(index + 1);
  }
  return { ...source, program: program as Node, lineStarts };
}

export function lineOf(file: ParsedFile, offset: number): number {
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

export function walk(
  node: Node,
  visit: (node: Node, ancestors: Node[]) => void,
  stack: Node[] = [],
) {
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

export function calleePath(call: Node): string | null {
  return call.type === "CallExpression" ? memberPath(call.callee as Node) : null;
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

/** The declared class type of a field: `X`, `X | null` or `new X(...)`. */
function declaredType(annotation: Node | null | undefined, value?: Node | null): string | null {
  const type = annotation ? unwrapTypeAnnotation(annotation) : null;
  if (type) return type;
  const created = value ? unwrap(value) : null;
  if (created?.type === "NewExpression" && created.callee.type === "Identifier") {
    return created.callee.name;
  }
  return null;
}

function unwrapTypeAnnotation(node: Node): string | null {
  let type = node.type === "TSTypeAnnotation" ? (node.typeAnnotation as Node) : node;
  if (type.type === "TSUnionType") {
    const named = (type.types as Node[]).filter((member) => member.type === "TSTypeReference");
    if (named.length !== 1) return null;
    type = named[0]!;
  }
  if (type.type !== "TSTypeReference") return null;
  const name = type.typeName as Node;
  return name.type === "Identifier" ? name.name : null;
}

export function analyzeStorageWriters(
  sources: SourceFile[],
  options: { rootClass: string },
): Analysis {
  const files = sources.map(parse);
  const declared = new Map<string, ClassInfo>();
  for (const file of files) {
    walk(file.program, (node) => {
      if ((node.type !== "ClassDeclaration" && node.type !== "ClassExpression") || !node.id) return;
      const superClass = node.superClass ? unwrap(node.superClass as Node) : null;
      const fields = new Map<string, Field>();
      for (const element of (node as Node & { body: { body: Node[] } }).body.body) {
        if (element.type === "PropertyDefinition" && !element.computed) {
          const name = propertyName(element.key as Node);
          const value = element.value as Node | null;
          if (name && !(value && isFunction(value))) {
            fields.set(name, {
              type: declaredType(element.typeAnnotation as Node | null, value),
              readonly: Boolean(element.readonly),
              accessibility:
                (element.key as Node).type === "PrivateIdentifier"
                  ? "private"
                  : (element.accessibility ?? "public"),
              from: value ? memberPath(unwrap(value)) : null,
            });
          }
        }
        if (element.type === "MethodDefinition" && element.kind === "constructor") {
          for (const param of (element.value as Node & { params: Node[] }).params) {
            if (param.type !== "TSParameterProperty") continue;
            const target = param.parameter as Node;
            if (target.type !== "Identifier") continue;
            fields.set(target.name, {
              type: declaredType(target.typeAnnotation as Node | null),
              readonly: Boolean(param.readonly),
              accessibility: param.accessibility ?? "public",
            });
          }
        }
      }
      declared.set(node.id.name, {
        name: node.id.name,
        superName: superClass?.type === "Identifier" ? superClass.name : null,
        node,
        file,
        fields,
      });
    });
  }

  // Area types: `type KanbanStorage = Pick<KanbanRepository, "a" | "b">`.
  const areaTypes = new Map<
    string,
    { className: string; names: string[] | null; node: Node; file: ParsedFile }
  >();
  for (const file of files) {
    walk(file.program, (node) => {
      if (node.type !== "TSTypeAliasDeclaration") return;
      const type = node.typeAnnotation as Node;
      if (type.type !== "TSTypeReference" || (type.typeName as Node).type !== "Identifier") return;
      if ((type.typeName as Node & { name: string }).name !== "Pick") return;
      const [target, keys] = ((type.typeArguments as (Node & { params: Node[] }) | null)?.params ??
        []) as Node[];
      const className = target ? unwrapTypeAnnotation(target) : null;
      if (!className || !declared.has(className)) return;
      const literals = keys?.type === "TSUnionType" ? (keys.types as Node[]) : keys ? [keys] : [];
      const names = literals.map((literal) => {
        const value =
          literal.type === "TSLiteralType"
            ? (literal.literal as Node & { value: unknown }).value
            : null;
        return typeof value === "string" ? value : null;
      });
      areaTypes.set((node.id as Node & { name: string }).name, {
        className,
        names: names.every((name) => name !== null) ? (names as string[]) : null,
        node,
        file,
      });
    });
  }

  // The root and every class it reaches through a typed field.
  const scanned: ClassInfo[] = [];
  const pendingClasses = [options.rootClass];
  while (pendingClasses.length > 0) {
    const name = pendingClasses.shift()!;
    if (scanned.some((info) => info.name === name) || PRIMITIVE_FIELDS.has(name)) continue;
    const info = declared.get(name);
    if (!info) {
      if (name === options.rootClass) throw new Error(`Class ${name} was not scanned`);
      continue;
    }
    scanned.push(info);
    for (const field of info.fields.values()) {
      if (field.type && declared.has(field.type)) pendingClasses.push(field.type);
      const area = field.type ? areaTypes.get(field.type) : undefined;
      if (area) pendingClasses.push(area.className);
    }
  }
  const scannedByName = new Map(scanned.map((info) => [info.name, info]));

  const violations: string[] = [];
  const location = (file: ParsedFile, node: Node) => `${file.file}:${lineOf(file, node.start)}`;

  // Inheritance would bring back members the per-class resolution cannot see.
  for (const info of scanned) {
    if (info.superName) {
      violations.push(
        `${location(info.file, info.node)} ${info.name}: extends ${info.superName}; hold it as a field instead`,
      );
    }
  }
  // A class that holds a StorageContext writes stores, so the scan must reach it.
  for (const info of declared.values()) {
    if (scannedByName.has(info.name) || PRIMITIVE_FIELDS.has(info.name)) continue;
    if ([...info.fields.values()].some((field) => field.type === "StorageContext")) {
      violations.push(
        `${location(info.file, info.node)} ${info.name}: holds a StorageContext but ${options.rootClass} does not reach it through a typed field`,
      );
    }
  }

  const members: Member[] = [];
  for (const info of scanned) {
    const body = (info.node as Node & { body: { body: Node[] } }).body.body;
    for (const node of body) {
      if (node.type !== "MethodDefinition" && node.type !== "PropertyDefinition") continue;
      const fn = node.value as Node | null;
      if (!fn || !isFunction(fn)) continue;
      const key = node.key as Node;
      // A computed key cannot be called by name, so it counts as public: its
      // writes must hold their lease inside it.
      const name = node.computed ? null : propertyName(key);
      const memberName = name ?? `[${text(info.file, key)}]`;
      members.push({
        className: info.name,
        name: memberName,
        key: `${info.name}.${memberName}`,
        accessibility:
          key.type === "PrivateIdentifier" ? "private" : (node.accessibility ?? "public"),
        node,
        fn,
        file: info.file,
      });
    }
  }
  const memberByKey = new Map(members.map((member) => [member.key, member]));

  // The root's public fields. One typed as an area (`Pick<Repository, ...>`)
  // makes each picked member an entry point. One holding a scanned class, by
  // its type or by copying another field, would hand callers methods the
  // analysis treats as internal.
  const areas = new Map<string, string[]>();
  const areaEntries = new Set<string>();
  const root = scannedByName.get(options.rootClass)!;
  for (const [name, field] of root.fields) {
    if (field.accessibility !== "public") continue;
    const area = field.type ? areaTypes.get(field.type) : undefined;
    if (!area) {
      if ((field.type && declared.has(field.type)) || field.from?.startsWith("this.")) {
        violations.push(
          `${location(root.file, root.node)} ${options.rootClass}.${name}: expose a repository as a Pick of its entry points, not ${field.type ?? field.from}`,
        );
      }
      continue;
    }
    if (!area.names) {
      violations.push(
        `${location(area.file, area.node)} ${field.type}: pick the entry points as string literals`,
      );
      continue;
    }
    const owner = scannedByName.get(area.className)!;
    const keys: string[] = [];
    for (const picked of area.names) {
      const key = `${area.className}.${picked}`;
      if (memberByKey.get(key)?.accessibility === "public") {
        areaEntries.add(key);
        keys.push(key);
      } else if (owner.fields.get(picked)?.accessibility !== "public") {
        violations.push(
          `${location(area.file, area.node)} ${field.type}: ${area.className} has no public member ${picked}`,
        );
      }
    }
    areas.set(name, keys);
  }

  const fieldOf = (className: string, name: string): Field | null =>
    scannedByName.get(className)?.fields.get(name) ??
    PRIMITIVE_FIELDS.get(className)?.get(name) ??
    null;

  /** What `this.a.b.c` names inside `className`: a member, a primitive or nothing. */
  const resolve = (node: Node, className: string): Resolved => {
    const target = memberPath(node);
    if (!target) return null;
    const segments = target.split(".");
    if (segments[0] !== "this" || segments.length < 2) return null;
    let current = className;
    for (const segment of segments.slice(1, -1)) {
      const next = fieldOf(current, segment)?.type;
      if (!next) return null;
      current = next;
    }
    const name = segments.at(-1)!;
    if (PRIMITIVE_FIELDS.has(current)) {
      const primitive = `${current}.${name}`;
      return { primitive, info: PRIMITIVES.get(primitive) ?? null };
    }
    const member = memberByKey.get(`${current}.${name}`);
    return member ? { member } : null;
  };
  const resolveCall = (call: Node, className: string): Resolved =>
    call.type === "CallExpression" ? resolve(call.callee as Node, className) : null;
  const memberOf = (resolved: Resolved): Member | null =>
    resolved && "member" in resolved ? resolved.member : null;
  const primitiveOf = (resolved: Resolved): Primitive | null =>
    resolved && "primitive" in resolved ? resolved.info : null;
  const classOf = (ancestors: Node[]): string | null => {
    const owner = ancestors.findLast(
      (node) => node.type === "ClassDeclaration" || node.type === "ClassExpression",
    );
    return owner?.type === "ClassDeclaration" || owner?.type === "ClassExpression"
      ? (owner.id?.name ?? null)
      : null;
  };

  const calls: CallSite[] = [];
  const valueReferences = new Map<string, Array<{ member: Member; node: Node }>>();
  for (const member of members) {
    const classNode = scannedByName.get(member.className)!.node;
    walk(
      member.node,
      (node, ancestors) => {
        if (node.type === "CallExpression") {
          calls.push({ call: node, ancestors: [...ancestors], member });
          return;
        }
        if (node.type !== "MemberExpression" || node.computed) return;
        const parent = ancestors.at(-1);
        if (parent?.type === "CallExpression" && parent.callee === node) return;
        if (parent?.type === "MemberExpression" && parent.object === node) return;
        const referenced = memberOf(resolve(node, member.className));
        if (!referenced) return;
        valueReferences.set(referenced.key, [
          ...(valueReferences.get(referenced.key) ?? []),
          { member, node },
        ]);
      },
      [classNode],
    );
  }

  // The context is handed to repositories by constructors, and used as a
  // value nowhere else: a member that returns or stores it would give code the
  // scan does not read a way to write.
  for (const info of scanned) {
    walk(info.node, (node, ancestors) => {
      if (node.type !== "MemberExpression" || node.computed) return;
      if (unwrap(node.object as Node).type !== "ThisExpression") return;
      const name = propertyName(node.property as Node);
      if (!name || info.fields.get(name)?.type !== "StorageContext") return;
      const parent = ancestors.at(-1);
      if (parent?.type === "MemberExpression" && parent.object === node && !parent.computed) return;
      const owner = members.find((member) => ancestors.includes(member.node));
      const inConstructor = ancestors.some(
        (ancestor) => ancestor.type === "MethodDefinition" && ancestor.kind === "constructor",
      );
      if (inConstructor) return;
      violations.push(
        `${location(info.file, node)} ${info.name}${owner ? `.${owner.name}` : ""}: uses this.${name} as a value, which the analysis cannot follow`,
      );
    });
  }

  // Writes the member walk above did not visit (a static block, a field
  // initializer) cannot be followed, so they fail.
  const collected = new Set<Node>(calls.map((site) => site.call));
  for (const info of scanned) {
    walk(info.node, (node) => {
      if (node.type !== "CallExpression" || collected.has(node)) return;
      const primitive = primitiveOf(resolveCall(node, info.name));
      if (primitive?.kind !== "write") return;
      violations.push(
        `${location(info.file, node)} ${info.name}: ${calleePath(node)!.replace(/^this\./, "")} outside any method the analysis can follow`,
      );
    });
  }

  const callersByKey = new Map<string, CallSite[]>();
  for (const site of calls) {
    const callee = memberOf(resolveCall(site.call, site.member.className));
    if (callee) callersByKey.set(callee.key, [...(callersByKey.get(callee.key) ?? []), site]);
  }

  // A lease wrapper runs one of its arguments (`operation`) under a lease on
  // `target`, which is either one of its parameters or an expression of its own.
  type LeaseWrapper = {
    operation: number;
    target: { param: number } | { node: Node; file: ParsedFile; className: string };
  };
  const SERIALIZE: LeaseWrapper = { operation: 2, target: { param: 0 } };
  const wrappers = new Map<string, LeaseWrapper | null>();
  const leaseWrapper = (resolved: Resolved): LeaseWrapper | null => {
    if (primitiveOf(resolved)?.kind === "lease") return SERIALIZE;
    const member = memberOf(resolved);
    if (!member) return null;
    if (wrappers.has(member.key)) return wrappers.get(member.key)!;
    wrappers.set(member.key, null);
    const shape = wrapperShape(member);
    wrappers.set(member.key, shape);
    return shape;
  };
  const wrapperShape = (member: Member): LeaseWrapper | null => {
    const params = paramNames(member.fn);
    const inner: CallExpression[] = [];
    walk(member.fn, (node) => {
      if (node.type === "CallExpression") inner.push(node);
    });
    for (const node of inner) {
      const resolved = resolveCall(node, member.className);
      if (memberOf(resolved) === member) continue;
      const wrapper = leaseWrapper(resolved);
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
        target =
          targetParam >= 0
            ? { param: targetParam }
            : { node: argument, file: member.file, className: member.className };
      }
      return { operation: operationParam, target };
    }
    return null;
  };

  // A lease target is store-wide only when it is the same string for every
  // caller. Anything read from a local, a parameter the caller fills in from
  // its own state, or a mutable field names one key's lease.
  const stableMembers = new Map<string, boolean>();
  const isReadonlyPath = (node: Node, className: string): boolean => {
    const target = memberPath(node);
    const segments = target?.split(".") ?? [];
    if (segments[0] !== "this" || segments.length < 2) return false;
    let current: string | null = className;
    for (const segment of segments.slice(1)) {
      const field: Field | null = current ? fieldOf(current, segment) : null;
      if (!field?.readonly) return false;
      current = field.type;
    }
    return true;
  };
  const isStable = (node: Node, bound: Set<string>, className: string): boolean => {
    const target = unwrap(node);
    switch (target.type) {
      case "Literal":
        return true;
      case "TemplateLiteral":
        return (target.expressions as Node[]).every((part) => isStable(part, bound, className));
      case "BinaryExpression":
        return (
          target.operator === "+" &&
          isStable(target.left as Node, bound, className) &&
          isStable(target.right as Node, bound, className)
        );
      case "Identifier":
        return bound.has(target.name);
      case "MemberExpression":
        return !target.computed && isReadonlyPath(target, className);
      case "CallExpression": {
        if (
          !(target.arguments as Node[]).every((argument) => isStable(argument, bound, className))
        ) {
          return false;
        }
        const callee = calleePath(target);
        if (callee === "path.join" || callee === "path.resolve") return true;
        const resolved = resolveCall(target, className);
        if (primitiveOf(resolved)?.kind === "path") return true;
        const member = memberOf(resolved);
        return member !== null && stableMember(member);
      }
      default:
        return false;
    }
  };
  // A helper is stable when it only returns a stable expression of its
  // parameters, which the call site has already checked.
  const stableMember = (member: Member): boolean => {
    if (stableMembers.has(member.key)) return stableMembers.get(member.key)!;
    stableMembers.set(member.key, false);
    const returned = onlyReturned(member.fn);
    const stable =
      returned !== null && isStable(returned, new Set(paramNames(member.fn)), member.className);
    stableMembers.set(member.key, stable);
    return stable;
  };

  /** `kanbanFile` for `this.files.kanbanFile()`, else `null`. */
  const storeMethodCall = (node: Node, className: string): Member | null => {
    const target = unwrap(node);
    return target.type === "CallExpression" ? memberOf(resolveCall(target, className)) : null;
  };

  const describeLease = (
    wrapper: LeaseWrapper,
    call: CallExpression,
    file: ParsedFile,
    className: string,
  ): Lease => {
    const target =
      "param" in wrapper.target
        ? { node: unwrap(call.arguments[wrapper.target.param] as Node), file, className }
        : {
            node: unwrap(wrapper.target.node),
            file: wrapper.target.file,
            className: wrapper.target.className,
          };
    // A keyed lease does not exclude writers holding another key's.
    const keyed = !isStable(target.node, new Set(), target.className);
    const store = storeMethodCall(target.node, target.className);
    if (!keyed && store && (target.node as Node & { arguments: Node[] }).arguments.length === 0) {
      return { name: store.name, keyed: false };
    }
    const name = text(target.file, target.node);
    return { name: keyed ? `keyed: ${name}` : name, keyed };
  };

  // Members whose call returns a promise. Such a call on a write path must be
  // awaited or returned, or its write can land after the lease is released.
  const promiseMembers = new Map<string, boolean>();
  const returnsPromise = (resolved: Resolved): boolean => {
    const primitive = primitiveOf(resolved);
    if (primitive) {
      return (
        primitive.kind === "atomically" ||
        primitive.kind === "lease" ||
        (primitive.kind === "write" &&
          (resolved as { primitive: string }).primitive.startsWith("StorageContext.") &&
          primitive.write === "whole") ||
        (primitive.kind === "other" && primitive.async)
      );
    }
    const member = memberOf(resolved);
    if (!member) return false;
    if (promiseMembers.has(member.key)) return promiseMembers.get(member.key)!;
    promiseMembers.set(member.key, true);
    const fn = member.fn as Node & { async?: boolean; returnType?: Node | null };
    let result: boolean;
    if (fn.async) result = true;
    else if (fn.returnType) {
      result = /\b(?:Promise|PromiseLike|any|unknown)\b/.test(text(member.file, fn.returnType));
    } else {
      result = returnedExpressions(fn).some((expression) => {
        const value = unwrap(expression);
        if (value.type === "NewExpression" || value.type === "AwaitExpression") return true;
        if (value.type !== "CallExpression") return false;
        const inner = resolveCall(value, member.className);
        return inner ? returnsPromise(inner) : (calleePath(value)?.startsWith("Promise.") ?? false);
      });
    }
    promiseMembers.set(member.key, result);
    return result;
  };
  /** Why `call` may outlive its enclosing function, or `null` when it cannot. */
  const unsettled = (call: Node, ancestors: Node[], file: ParsedFile): string | null => {
    const className = classOf(ancestors);
    const resolved = className ? resolveCall(call, className) : null;
    if (!resolved || !returnsPromise(resolved) || settled(call, ancestors)) return null;
    return `${text(file, (call as CallExpression).callee as Node)}(...) at ${location(file, call)} is neither awaited nor returned, so it may finish after the lease is released`;
  };

  const storeMembers = new Map<string, Member>();
  // A helper whose whole body is `return this.context.storeForFile(this.files.xFile())`
  // names the same store as `xFile`.
  const resolveStore = (
    node: Node,
    ancestors: Node[],
    className: string,
    depth = 0,
  ): string | null => {
    if (depth > 8) return null;
    const target = unwrap(node);
    if (target.type === "CallExpression") {
      const resolved = resolveCall(target, className);
      const args = target.arguments as Node[];
      if (primitiveOf(resolved)?.kind === "store-for-file" && args[0]) {
        return resolveStore(args[0], ancestors, className, depth + 1);
      }
      const member = memberOf(resolved);
      if (!member) return null;
      const returned = onlyReturned(member.fn);
      if (returned) {
        const inner = unwrap(returned);
        if (
          inner.type === "CallExpression" &&
          primitiveOf(resolveCall(inner, member.className))?.kind === "store-for-file"
        ) {
          return resolveStore(inner, [member.fn], member.className, depth + 1);
        }
      }
      storeMembers.set(member.name, member);
      return member.name;
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
                ? resolveStore(
                    declarator.init as Node,
                    ancestors.slice(0, index + 1),
                    className,
                    depth + 1,
                  )
                : null;
            }
          }
        }
      }
    }
    return null;
  };

  const isAtomically = (node: Node | undefined, className: string | null): boolean =>
    Boolean(
      node &&
      className &&
      node.type === "CallExpression" &&
      primitiveOf(resolveCall(node, className))?.kind === "atomically",
    );

  /** Leases taken between `ancestors`' innermost function and its class member. */
  const contextOf = (
    ancestors: Node[],
    file: ParsedFile,
  ): { leases: Lease[]; member: Member | null; problem?: string } => {
    const leases: Lease[] = [];
    const className = classOf(ancestors);
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
        const resolved = className ? resolveCall(parent, className) : null;
        if (primitiveOf(resolved)?.kind === "synchronous-callback") continue;
        const wrapper = leaseWrapper(resolved);
        const leased = wrapper && (parent.arguments as Node[]).indexOf(node) === wrapper.operation;
        const atomic = isAtomically(parent, className);
        if (atomic || leased) {
          const problem = unsettled(parent, ancestors.slice(0, index - 1), file);
          if (problem) return { leases, member: null, problem };
        }
        if (atomic) {
          // The scope commits its buffered writes when it ends, after any
          // lease taken inside it is released.
          if (leases.length > 0) {
            return {
              leases,
              member: null,
              problem: `inside a lease taken within this.context.atomically at ${location(file, parent)}, which commits after the lease is released`,
            };
          }
          continue;
        }
        if (leased) {
          leases.push(describeLease(wrapper, parent, file, className!));
          continue;
        }
        const callee = calleePath(parent);
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

  const insideAtomically = (ancestors: Node[]) => {
    const className = classOf(ancestors);
    return ancestors.some(
      (node, index) => isFunction(node) && isAtomically(ancestors[index - 1], className),
    );
  };

  // Members that can run inside an `atomically` scope: everything called,
  // transitively, from an `atomically` callback.
  const atomicMembers = new Set<string>();
  const pending: Member[] = [];
  for (const site of calls) {
    if (!isAtomically(site.call, site.member.className)) continue;
    for (const argument of site.call.arguments) {
      walk(argument as Node, (node) => {
        const member =
          node.type === "CallExpression"
            ? memberOf(resolveCall(node, site.member.className))
            : null;
        if (member) pending.push(member);
      });
    }
  }
  while (pending.length > 0) {
    const member = pending.pop()!;
    if (atomicMembers.has(member.key)) continue;
    atomicMembers.add(member.key);
    for (const site of calls) {
      if (site.member !== member) continue;
      const callee = memberOf(resolveCall(site.call, member.className));
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
    const entry =
      (member.className === options.rootClass && member.accessibility === "public") ||
      areaEntries.has(member.key);
    if (context.leases.some((lease) => !lease.keyed) || entry) {
      return [{ leases: context.leases, via, entry: member }];
    }
    if (seen.has(member.key)) {
      return [
        { leases: context.leases, via, entry: member, problem: `recursion through ${member.key}` },
      ];
    }
    const out: WritePath[] = [];
    for (const reference of valueReferences.get(member.key) ?? []) {
      out.push({
        leases: context.leases,
        via,
        entry: member,
        problem: `${member.name} is used without being called at ${location(reference.member.file, reference.node)}`,
      });
    }
    const callers = callersByKey.get(member.key) ?? [];
    if (callers.length === 0) {
      out.push({
        leases: context.leases,
        via,
        entry: member,
        problem: `${member.className}.${member.name} has no caller`,
      });
    }
    for (const caller of callers) {
      const step = `${member.name} ← ${caller.member.className}.${caller.member.name} (${location(caller.member.file, caller.call)})`;
      for (const outer of pathsFrom(
        caller.call,
        caller.ancestors,
        caller.member.file,
        [...via, step],
        new Set([...seen, member.key]),
      )) {
        out.push({ ...outer, leases: [...context.leases, ...outer.leases] });
      }
    }
    return out;
  };

  const sites: WriteSite[] = [];
  for (const site of calls) {
    const primitive = primitiveOf(resolveCall(site.call, site.member.className));
    if (primitive?.kind !== "write") continue;
    let kind = primitive.write;
    const file = site.member.file;
    const where = `${location(file, site.call)} ${site.member.className}.${site.member.name}`;
    const call = calleePath(site.call)!.replace(/^this\./, "");
    const argument = site.call.arguments[0] as Node | undefined;
    const store = argument ? resolveStore(argument, site.ancestors, site.member.className) : null;
    if (!store) {
      violations.push(`${where}: cannot resolve the store written by ${call}`);
      continue;
    }
    let reason: string | undefined;
    if (kind === "transactional") {
      if (insideAtomically(site.ancestors) || atomicMembers.has(site.member.key)) {
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

  // The path a store helper returns, relative to the data directory: `""` for
  // the directory itself, `*` for what a parameter or a local supplies.
  const pathOf = (
    node: Node,
    className: string,
    params: Map<string, string>,
    depth = 0,
  ): string | null => {
    if (depth > 8) return null;
    const target = unwrap(node);
    switch (target.type) {
      case "Literal":
        return typeof target.value === "string" ? target.value : null;
      case "TemplateLiteral": {
        const quasis = target.quasis as Array<Node & { value: { cooked: string | null } }>;
        let out = quasis[0]!.value.cooked ?? "";
        (target.expressions as Node[]).forEach((part, index) => {
          out += `${pathOf(part, className, params, depth + 1) ?? "*"}${quasis[index + 1]!.value.cooked ?? ""}`;
        });
        return out;
      }
      case "Identifier":
        return params.get(target.name) ?? null;
      case "MemberExpression":
        return /^this\.(?:context\.|files\.)?dataDir$/.test(memberPath(target) ?? "") ? "" : null;
      case "CallExpression": {
        const args = target.arguments as Node[];
        const parts = args.map((argument) => pathOf(argument, className, params, depth + 1));
        if (parts.some((part) => part === null)) return null;
        if (calleePath(target) === "path.join") {
          return parts.filter((part) => part !== "").join("/");
        }
        const resolved = resolveCall(target, className);
        if (primitiveOf(resolved)?.kind === "path") return parts[0] ?? null;
        const member = memberOf(resolved);
        if (!member) return null;
        const bound = new Map(
          paramNames(member.fn).map((name, index) => [name, parts[index] ?? "*"] as const),
        );
        return helperPath(member, bound, depth + 1);
      }
      default:
        return null;
    }
  };
  /** What every `return` of a helper evaluates to, when they agree. */
  const helperPath = (member: Member, params: Map<string, string>, depth = 0): string | null => {
    const paths = returnedExpressions(member.fn).map((returned) =>
      pathOf(returned, member.className, params, depth),
    );
    const [first] = paths;
    return first !== undefined && first !== null && paths.every((candidate) => candidate === first)
      ? first
      : null;
  };
  const storeNames = new Map<string, string>();
  for (const [store, member] of storeMembers) {
    // The helper's own parameters are what make one key's store differ
    // from another's.
    const unknown = new Map(paramNames(member.fn).map((name) => [name, "*"] as const));
    const relative = helperPath(member, unknown);
    if (relative === null) {
      violations.push(
        `${location(member.file, member.node)} ${member.key}: cannot tell which database store ${store} names`,
      );
      continue;
    }
    storeNames.set(store, relative.replace(/\.json$/, ""));
  }

  return {
    classes: scanned.map((info) => info.name),
    areas,
    storeNames,
    sites,
    stores,
    violations,
  };
}

/**
 * This module: the guard's own analysis, which only its tests import. Like
 * them it is not backend code, so neither source list includes it.
 */
const GUARD_SUPPORT = path.basename(import.meta.path);

export function readStorageSources(): SourceFile[] {
  return readdirSync(coreDir)
    .filter(
      (name) =>
        /^storage.*\.ts$/.test(name) && !name.endsWith(".test.ts") && name !== GUARD_SUPPORT,
    )
    .sort()
    .map((name) => ({
      file: path.relative(repoRoot, path.join(coreDir, name)),
      source: readFileSync(path.join(coreDir, name), "utf8"),
    }));
}

export function backendSourceFiles(dir = backendSrc): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...backendSourceFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !/\.(?:test|spec)\.ts$/.test(entry.name) &&
      full !== import.meta.path
    ) {
      out.push(full);
    }
  }
  return out;
}

let storageAnalysis: Analysis | undefined;
export function analyzeStorageService(): Analysis {
  storageAnalysis ??= analyzeStorageWriters(readStorageSources(), { rootClass: "StorageService" });
  return storageAnalysis;
}

/** The backend files that declare a class the scan reads. */
export function scannedFiles(): Set<string> {
  const { classes } = analyzeStorageService();
  const out = new Set<string>();
  for (const source of readStorageSources()) {
    const file = parse(source);
    walk(file.program, (node) => {
      if (node.type === "ClassDeclaration" && node.id && classes.includes(node.id.name)) {
        out.add(source.file);
      }
    });
  }
  return out;
}

/** `file:line` of every identifier in non-test backend sources outside `allowed` that `matches`. */
export function identifiersOutside(
  allowed: Set<string>,
  matches: (name: string) => boolean,
  mentions: (source: string) => boolean,
): string[] {
  const found: string[] = [];
  for (const full of backendSourceFiles()) {
    const relative = path.relative(repoRoot, full);
    if (allowed.has(relative)) continue;
    const source = readFileSync(full, "utf8");
    if (!mentions(source)) continue;
    const file = parse({ file: relative, source });
    walk(file.program, (node) => {
      if (node.type === "Identifier" && matches(node.name)) {
        found.push(`${file.file}:${lineOf(file, node.start)} ${node.name}`);
      }
    });
  }
  return found;
}

/**
 * Writes to the database that bypass `StorageService`: engines with stores of
 * their own (workflow results, the cleanup ledger, display tails, web
 * annotations, …) call `StorageDatabase` directly. The scan above cannot see
 * them, so each must write only stores no repository writes; a shared store
 * would mix its writers without a shared lease.
 */
const RAW_WRITERS = new Set([
  "writeStore",
  "writeStoreInTransaction",
  "writeRawDocumentInTransaction",
  "deleteStore",
  "deleteStoreInTransaction",
  "updateStore",
  "updateStoreRow",
  "rows",
]);

/** Files whose raw writes are not engine writes, with the reason. */
const RAW_WRITER_EXEMPTIONS = new Map([
  ["storage-database.ts", "implements the writes"],
  ["storage-context.ts", "implements the StorageService primitives the scan follows"],
  ["storage-test-support.ts", "seeds stores for tests, like another process"],
  [
    "storage-stores.ts",
    "the legacy import and migrations run in the migration transaction at open, before any writer",
  ],
  ["storage-record-upgrades.ts", "a one-shot upgrade inside a migration at open"],
  ["storage-retired-features.ts", "a one-shot retirement inside a migration at open"],
]);

export type RawWrite = { location: string; call: string; store: string | null };

/**
 * Whether `source` can contain one of the identifiers `pattern` matches,
 * spelled out or with escapes (`\u0072ows`). False means the file has none,
 * so the scan need not parse it.
 */
function mayName(source: string, pattern: RegExp): boolean {
  return pattern.test(source) || (source.includes("\\u") && pattern.test(unescaped(source)));
}

/** A pattern for any of the identifiers `names`, as a whole identifier. */
function identifiers(names: Iterable<string>): RegExp {
  const alternatives = [...names].map((name) => name.replace(/[$]/g, "\\$&")).join("|");
  return new RegExp(`(?<![\\w$])(?:${alternatives})(?![\\w$])`);
}

/** `source` with its `\u` escapes decoded, wherever they are. */
function unescaped(source: string): string {
  return source.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (escape, braced, plain) => {
    const code = Number.parseInt(braced ?? plain, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
  });
}

const RAW_WRITER_NAMES = identifiers(RAW_WRITERS);

/**
 * The store each raw database write names, as a pattern (`*` for a part only
 * known at run time), or `null` when the analysis cannot name it. Store names
 * are followed through `const`s, template literals and small functions such
 * as `webAnnotationStoreName`, across relative imports.
 */
export function rawDatabaseWrites(sources: SourceFile[], skipClasses: Set<string>): RawWrite[] {
  // Parsing every backend file and keeping every tree is most of the scan's
  // cost, so a file is parsed only when it can matter: when its text can call
  // a raw writer, or when a name being resolved leads into it.
  const byFile = new Map(sources.map((source) => [source.file, source]));
  const parsed = new Map<string, ParsedFile>();
  const parsedFile = (name: string): ParsedFile | null => {
    const source = byFile.get(name);
    if (!source) return null;
    let file = parsed.get(name);
    if (!file) {
      file = parse(source);
      parsed.set(name, file);
    }
    return file;
  };
  const modulePath = (from: ParsedFile, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    return path
      .join(path.dirname(from.file), specifier)
      .replace(/\.js$/, ".ts")
      .replace(/(?<!\.ts)$/, ".ts");
  };
  const moduleOf = (from: ParsedFile, specifier: string): ParsedFile | null => {
    const target = modulePath(from, specifier);
    return target === null ? null : parsedFile(target);
  };
  const topLevel = (file: ParsedFile, name: string): Node | null => {
    for (const statement of (file.program as Node & { body: Node[] }).body) {
      const declaration =
        statement.type === "ExportNamedDeclaration" && statement.declaration
          ? (statement.declaration as Node)
          : statement;
      if (declaration.type === "FunctionDeclaration" && declaration.id?.name === name) {
        return declaration;
      }
      if (declaration.type === "VariableDeclaration" && declaration.kind === "const") {
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === "Identifier" && declarator.id.name === name) {
            return (declarator.init as Node | null) ?? null;
          }
        }
      }
      if (declaration.type === "ImportDeclaration") {
        for (const specifier of declaration.specifiers) {
          if (specifier.local.name !== name) continue;
          const source = moduleOf(file, declaration.source.value);
          const imported =
            specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : null;
          return source && imported ? topLevelIn(source)(imported) : null;
        }
      }
    }
    return null;
  };
  // Where a resolved declaration lives, so its own names resolve in its file.
  const ownerFile = new Map<Node, ParsedFile>();
  const lookups = new Map<ParsedFile, (name: string) => Node | null>();
  const topLevelIn = (file: ParsedFile): ((name: string) => Node | null) => {
    let lookup = lookups.get(file);
    if (!lookup) {
      lookup = (name) => {
        const found = topLevel(file, name);
        if (found && !ownerFile.has(found)) ownerFile.set(found, file);
        return found;
      };
      lookups.set(file, lookup);
    }
    return lookup;
  };
  const nameOf = (
    node: Node,
    file: ParsedFile,
    scopes: Node[],
    params: Set<string>,
    depth = 0,
  ): string | null => {
    if (depth > 12) return null;
    const target = unwrap(node);
    switch (target.type) {
      case "Literal":
        return typeof target.value === "string" ? target.value : null;
      case "TemplateLiteral": {
        const quasis = target.quasis as Array<Node & { value: { cooked: string | null } }>;
        let out = quasis[0]!.value.cooked ?? "";
        (target.expressions as Node[]).forEach((part, index) => {
          out += `${nameOf(part, file, scopes, params, depth + 1) ?? "*"}${quasis[index + 1]!.value.cooked ?? ""}`;
        });
        return out;
      }
      case "BinaryExpression": {
        if (target.operator !== "+") return null;
        const left = nameOf(target.left as Node, file, scopes, params, depth + 1);
        const right = nameOf(target.right as Node, file, scopes, params, depth + 1);
        return left !== null && right !== null ? left + right : null;
      }
      case "Identifier": {
        if (params.has(target.name)) return null;
        for (let index = scopes.length - 1; index >= 0; index -= 1) {
          const scope = scopes[index]!;
          const statements = scope.type === "BlockStatement" ? (scope.body as Node[]) : [];
          for (const statement of statements) {
            if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
            for (const declarator of statement.declarations) {
              if (declarator.id.type === "Identifier" && declarator.id.name === target.name) {
                return declarator.init
                  ? nameOf(
                      declarator.init as Node,
                      file,
                      scopes.slice(0, index + 1),
                      params,
                      depth + 1,
                    )
                  : null;
              }
            }
          }
        }
        const declared = topLevelIn(file)(target.name);
        if (!declared || isFunction(declared)) return null;
        return nameOf(declared, ownerFile.get(declared) ?? file, [], new Set(), depth + 1);
      }
      case "MemberExpression": {
        // A field the constructor sets once (`this.storeName = …`).
        const field = target.computed ? null : propertyName(target.property as Node);
        if (unwrap(target.object as Node).type !== "ThisExpression" || !field) return null;
        const owner = scopes.findLast(
          (scope) => scope.type === "ClassDeclaration" || scope.type === "ClassExpression",
        );
        const assigned: Array<{ value: Node; scopes: Node[]; params: Set<string> }> = [];
        if (owner) {
          walk(owner, (child, around) => {
            if (child.type === "PropertyDefinition" && !child.computed && child.value) {
              if (propertyName(child.key as Node) === field && !isFunction(child.value as Node)) {
                assigned.push({ value: child.value as Node, scopes: [owner], params: new Set() });
              }
              return;
            }
            if (child.type !== "AssignmentExpression") return;
            const left = unwrap(child.left as Node);
            if (
              left.type !== "MemberExpression" ||
              left.computed ||
              unwrap(left.object as Node).type !== "ThisExpression" ||
              propertyName(left.property as Node) !== field
            ) {
              return;
            }
            const method = around.findLast((ancestor) => ancestor.type === "MethodDefinition");
            const fn = around.findLast((ancestor) => isFunction(ancestor));
            assigned.push({
              value: child.right as Node,
              scopes:
                method?.type === "MethodDefinition" && method.kind === "constructor"
                  ? [...around]
                  : [],
              params: new Set(fn ? paramNames(fn) : []),
            });
          });
        }
        // Set anywhere but the constructor, or more than once, it may change.
        if (assigned.length !== 1 || assigned[0]!.scopes.length === 0) return null;
        const [only] = assigned;
        return nameOf(only!.value, file, only!.scopes, only!.params, depth + 1);
      }
      case "CallExpression": {
        const callee = unwrap(target.callee as Node);
        if (callee.type !== "Identifier") return null;
        const fn = topLevelIn(file)(callee.name);
        if (!fn || !isFunction(fn)) return null;
        // An argument only picks one store of the family the function names.
        const names = returnedExpressions(fn).map((returned) =>
          nameOf(returned, ownerFile.get(fn) ?? file, [], new Set(paramNames(fn)), depth + 1),
        );
        const [first] = names;
        return first !== undefined && first !== null && names.every((name) => name === first)
          ? first
          : null;
      }
      default:
        return null;
    }
  };

  /** Calls of the top-level function `name` of `declaring`, in it and where it is imported. */
  const callsOf = (declaring: ParsedFile, name: string) => {
    const callee = identifiers([name]);
    const found: Array<{
      call: CallExpression;
      ancestors: Node[];
      file: ParsedFile;
      location: string;
    }> = [];
    for (const source of byFile.values()) {
      // Only the declaring file and a file whose text names the function can
      // call it.
      if (source.file !== declaring.file && !mayName(source.source, callee)) continue;
      const file = parsedFile(source.file)!;
      let local: string | null = file === declaring ? name : null;
      for (const statement of (file.program as Node & { body: Node[] }).body) {
        if (local || statement.type !== "ImportDeclaration") continue;
        if (modulePath(file, statement.source.value) !== declaring.file) continue;
        for (const specifier of statement.specifiers as Node[]) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === name
          ) {
            local = specifier.local.name;
          }
        }
      }
      if (!local) continue;
      walk(file.program, (node, ancestors) => {
        if (node.type !== "CallExpression") return;
        const callee = unwrap(node.callee as Node);
        if (callee.type !== "Identifier" || callee.name !== local) return;
        found.push({
          call: node,
          ancestors: [...ancestors],
          file,
          location: `${file.file}:${lineOf(file, node.start)}`,
        });
      });
    }
    return found;
  };

  /**
   * The stores `argument` can name. A row helper that takes the store as a
   * parameter (`writeRecordRows(database, store, …)`) writes whatever its
   * callers pass, so a parameter of a top-level function is followed to every
   * call of it.
   */
  const storesNamedBy = (
    argument: Node | undefined,
    file: ParsedFile,
    ancestors: Node[],
    depth = 0,
  ): Array<{ via: string; store: string | null }> => {
    if (!argument || depth > 4) return [{ via: "", store: null }];
    // The function that declares the identifier, if it is a parameter.
    const enclosing = ancestors.findLast(
      (ancestor) =>
        isFunction(ancestor) &&
        argument.type === "Identifier" &&
        paramNames(ancestor).includes(argument.name),
    );
    const params = enclosing ? paramNames(enclosing) : [];
    const delegated =
      argument.type === "Identifier" && enclosing?.type === "FunctionDeclaration"
        ? params.indexOf(argument.name)
        : -1;
    if (delegated < 0) {
      const inner = ancestors.findLast((ancestor) => isFunction(ancestor));
      const bound = new Set(inner ? paramNames(inner) : []);
      for (const name of params) bound.add(name);
      return [{ via: "", store: nameOf(argument, file, ancestors, bound) }];
    }
    const helper = (enclosing as Node & { id: { name: string } | null }).id?.name;
    const callers = helper ? callsOf(file, helper) : [];
    if (callers.length === 0) return [{ via: "", store: null }];
    return callers.flatMap((caller) =>
      storesNamedBy(
        caller.call.arguments[delegated] as Node | undefined,
        caller.file,
        caller.ancestors,
        depth + 1,
      ).map((named) => ({ via: ` via ${caller.location}${named.via}`, store: named.store })),
    );
  };

  const writes: RawWrite[] = [];
  for (const source of byFile.values()) {
    if (RAW_WRITER_EXEMPTIONS.has(path.basename(source.file))) continue;
    if (!mayName(source.source, RAW_WRITER_NAMES)) continue;
    const file = parsedFile(source.file)!;
    walk(file.program, (node, ancestors) => {
      if (node.type !== "CallExpression") return;
      const callee = unwrap(node.callee as Node);
      if (callee.type !== "MemberExpression" || callee.computed) return;
      const method = propertyName(callee.property as Node);
      if (!method || !RAW_WRITERS.has(method)) return;
      // `this.rows(...)` is a class's own method, not the database's.
      if (unwrap(callee.object as Node).type === "ThisExpression") return;
      const owner = ancestors.findLast(
        (ancestor) => ancestor.type === "ClassDeclaration" || ancestor.type === "ClassExpression",
      );
      const className =
        owner?.type === "ClassDeclaration" || owner?.type === "ClassExpression"
          ? (owner.id?.name ?? null)
          : null;
      // The repositories' own writes are the scan above.
      if (className && skipClasses.has(className)) return;
      const location = `${file.file}:${lineOf(file, node.start)}`;
      const argument = node.arguments[0] as Node | undefined;
      for (const named of storesNamedBy(argument, file, ancestors)) {
        writes.push({ location: `${location}${named.via}`, call: method, store: named.store });
      }
    });
  }
  return writes;
}

/** Whether two store patterns (`*` for any text) can name the same store. */
export function storesOverlap(left: string, right: string): boolean {
  const pattern = (value: string) =>
    new RegExp(
      `^${value
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
  return (
    pattern(left).test(right.replaceAll("*", "x")) || pattern(right).test(left.replaceAll("*", "x"))
  );
}

export function backendSources(): SourceFile[] {
  return backendSourceFiles().map((full) => ({
    file: path.relative(repoRoot, full),
    source: readFileSync(full, "utf8"),
  }));
}

export const REPOSITORIES = [
  "ProjectsRepository",
  "ConfigRepository",
  "SessionsRepository",
  "ReviewsRepository",
  "NativeAgentSessionsRepository",
  "NativeAgentDeliveries",
  "PromptQueueStore",
  "PromptsRepository",
  "BuildPipelinesRepository",
  "DraftsRepository",
  "AgentMailRepository",
  "AgentMailStore",
  "AgentMailboxDirectory",
  "AgentMailInjects",
  "AgentMailBudgets",
  "KanbanRepository",
  "PreviewServicesRepository",
  "NodesRepository",
  "PublicOperationsRepository",
  "CoordinatorsRepository",
  "AgentAccountsRepository",
  "ScheduledJobsRepository",
  "PermissionRulesRepository",
];
