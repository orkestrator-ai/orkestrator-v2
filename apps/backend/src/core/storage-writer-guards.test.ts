import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  analyzeStorageService,
  analyzeStorageWriters,
  backendSourceFiles,
  calleePath,
  coreDir,
  identifiersOutside,
  lineOf,
  parse,
  readStorageSources,
  repoRoot,
  REPOSITORIES,
  scannedFiles,
  walk,
} from "./storage-writer-guards-test-support.js";

describe("StorageService store writers", () => {
  test("every whole-value write holds a lease that every writer of its store holds", () => {
    expect(analyzeStorageService().violations).toEqual([]);
  });

  test("the scan covers the facade, every repository, its lease wrappers and its helpers", () => {
    const { classes, stores } = analyzeStorageService();
    expect(classes[0]).toBe("StorageService");
    expect(classes).toEqual(
      expect.arrayContaining(["StorageRepositories", "StorageFiles", ...REPOSITORIES]),
    );
    // Leased stores, including one helper reached from many callers in
    // several repositories and a store held under another store's lease.
    expect(stores.get("kanbanFile")).toMatchObject({ kind: "whole", leases: ["kanbanFile"] });
    expect(stores.get("environmentsFile")).toMatchObject({
      kind: "whole",
      leases: ["environmentsFile"],
    });
    expect(stores.get("environmentsFile")!.paths).toBeGreaterThan(10);
    expect(stores.get("environmentFinalPrFile")).toMatchObject({
      kind: "whole",
      leases: ["environmentsFile"],
    });
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
    // Agent mail's four classes write through one shared store and lease.
    expect(stores.get("agentMailFile")).toMatchObject({
      kind: "whole",
      leases: ["agentMailFile"],
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

  test("resume-identity writes stay transactional under the per-session lease", () => {
    const member = "NativeAgentSessionsRepository.saveNativeAgentSession";
    expect(analyzeStorageService().sites.find((site) => site.member === member)).toMatchObject({
      store: "nativeAgentSessionsFile",
      kind: "transactional",
    });
    // Turn the row writer into a whole-value writer: the production call graph
    // must reach the new facade entry and reject its per-key lease.
    const sources = readStorageSources().map((source) => ({
      ...source,
      source: source.source.replace(
        "this.context.updateStoreRow(this.files.nativeAgentSessionsFile(), key, () => {",
        "await this.context.saveSensitiveJson(this.files.nativeAgentSessionsFile(), key, () => {",
      ),
    }));
    const result = analyzeStorageWriters(sources, { rootClass: "StorageService" });
    const write = result.sites.find((site) => site.member === member)!;
    const resume = write.paths.filter(
      (route) => route.entry?.name === "recordNativeAgentSessionResumeIdentity",
    );
    expect(resume).toHaveLength(1);
    expect(resume[0]!.leases).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyed: true })]),
    );
    expect(result.violations.join("\n")).toContain("recordNativeAgentSessionResumeIdentity");
  });

  test("the facade's area fields make their picked members entry points", () => {
    const { areas } = analyzeStorageService();
    expect([...areas.keys()].sort()).toEqual([
      "agentAccounts",
      "bugReports",
      "coordinators",
      "graphDescribe",
      "graphEffects",
      "graphRuns",
      "graphTemplates",
      "kanban",
      "nodes",
      "previewServices",
      "publicOperations",
    ]);
    expect(areas.get("kanban")).toContain("KanbanRepository.saveLinearAuth");
    // Omitted from the area: only other repositories call it.
    expect(areas.get("publicOperations")).not.toContain(
      "PublicOperationsRepository.loadPublicOperationIndex",
    );
    // Drop the lease from an area method: the write must be traced to that
    // method as an entry, not to the (absent) callers inside the storage files.
    const sources = readStorageSources().map((source) => ({
      ...source,
      source: source.source.replace(
        `await this.enqueueLinearAuthMutation(() =>
      this.context.saveSensitiveJson(this.files.linearAuthFile(), auth),
    );`,
        "await this.context.saveSensitiveJson(this.files.linearAuthFile(), auth);",
      ),
    }));
    expect(sources.some((source) => source.source.includes("auth);\n    return auth;"))).toBe(true);
    const result = analyzeStorageWriters(sources, { rootClass: "StorageService" });
    expect(result.violations.join("\n")).toContain(
      "no store-wide lease reaches this write from KanbanRepository.saveLinearAuth",
    );
  });

  test("no backend class outside the scan calls the store write primitives", () => {
    const { classes } = analyzeStorageService();
    // StorageContext implements them.
    const allowed = new Set([...classes, "StorageContext"]);
    const primitive =
      /^this\.(?:context\.)?(?:saveJson|saveSensitiveJson|deleteStore|updateStore|updateStoreRow)$/;
    const outside: string[] = [];
    for (const full of backendSourceFiles()) {
      const source = readFileSync(full, "utf8");
      if (
        !/\b(?:saveJson|saveSensitiveJson|deleteStore|updateStore|updateStoreRow)\s*[<(]/.test(
          source,
        )
      ) {
        continue;
      }
      const file = parse({ file: path.relative(repoRoot, full), source });
      walk(file.program, (node, ancestors) => {
        const callee = node.type === "CallExpression" ? calleePath(node) : null;
        if (!callee || !primitive.test(callee)) return;
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
    // A class that writes stores outside the scan is invisible to the guard
    // above; reach it from StorageService through a typed field instead.
    expect(outside).toEqual([]);
  });

  test.each([
    ["StorageContext", "Storage\\u0043ontext"],
    ["ProjectsRepository", "Projects\\u{52}epository"],
  ])("finds escaped %s identifiers outside allowed files", (name, escaped) => {
    expect(
      identifiersOutside(
        new Set(["allowed.ts"]),
        (identifier) => identifier === name,
        (source) => source.includes(name),
        [
          { file: "escaped.ts", source: `export type Hidden = ${escaped};` },
          { file: "plain.ts", source: `export type Plain = ${name};` },
          { file: "allowed.ts", source: `export type Allowed = ${escaped};` },
          { file: "string.ts", source: `export const label = "${escaped}";` },
          { file: "comment.ts", source: `// ${escaped}\nexport const value = 1;` },
          { file: "unrelated.ts", source: `export const value = 1;` },
        ],
      ),
    ).toEqual([`escaped.ts:1 ${name}`, `plain.ts:1 ${name}`]);
  });

  test("only the scanned storage classes hold the StorageContext", () => {
    // A class that takes a StorageContext writes stores. The scan follows
    // every class StorageService reaches through a typed field; anything else
    // naming the context would write where the scan does not look.
    const allowed = new Set([
      ...scannedFiles(),
      ...["storage-context.ts", "storage-changes.ts", "storage-test-support.ts"].map((name) =>
        path.relative(repoRoot, path.join(coreDir, name)),
      ),
    ]);
    expect(
      identifiersOutside(
        allowed,
        (name) => name === "StorageContext",
        (source) => source.includes("StorageContext"),
      ),
    ).toEqual([]);
  });

  test("code outside the storage files reaches the repositories only through StorageService", () => {
    // Only StorageService's public methods and the members its area fields
    // pick are entry points, so a caller holding a repository could run a
    // write path the scan never checked. Callers name the area types instead.
    const { classes } = analyzeStorageService();
    const internal = new Set(classes.filter((name) => name !== "StorageService"));
    const allowed = new Set([
      ...scannedFiles(),
      path.relative(repoRoot, path.join(coreDir, "storage-test-support.ts")),
    ]);
    expect(
      identifiersOutside(
        allowed,
        (name) => internal.has(name),
        (source) => [...internal].some((name) => source.includes(name)),
      ),
    ).toEqual([]);
  });
});
