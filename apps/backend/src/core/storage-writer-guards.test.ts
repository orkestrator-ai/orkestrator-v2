import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  analyzeStorageService,
  analyzeStorageWriters,
  backendSources,
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
  WHOLE_TREE_SCAN_TIMEOUT_MS,
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
    // Row writes, every one of them still under the environment lease.
    expect(stores.get("environmentsFile")).toMatchObject({
      kind: "transactional",
      leases: ["environmentsFile"],
    });
    expect(stores.get("environmentsFile")!.paths).toBeGreaterThan(10);
    // The same for projects, including the public operations' revision-checked edit.
    expect(stores.get("projectsFile")).toMatchObject({
      kind: "transactional",
      leases: ["projectsFile"],
    });
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
    // Row writes too, reached from every queue mutation and steer path.
    expect(stores.get("promptQueuesFile")).toMatchObject({
      kind: "transactional",
      leases: ["promptQueuesFile"],
    });
    // The machine profile's compare-and-swap edit and its create-once read
    // share one lease, through a private helper.
    expect(stores.get("backendProfileFile")).toMatchObject({
      kind: "whole",
      leases: ["backendProfileFile"],
      paths: 3,
    });
    // Agent mail's four classes write through one shared store and lease,
    // including the environment delete's row diff.
    expect(stores.get("agentMailFile")).toMatchObject({
      kind: "whole",
      leases: ["agentMailFile"],
    });
    expect(
      analyzeStorageService().sites.find(
        (site) => site.member === "AgentMailStore.saveRows" && site.store === "agentMailFile",
      ),
    ).toMatchObject({ kind: "whole" });
    expect(stores.get("linearAuthFile")).toMatchObject({
      kind: "whole",
      leases: ["linearAuthFile"],
    });
    // Transactional stores, including a raw database writer resolved through
    // `buildPipelineStore()`.
    for (const store of [
      "composeDraftsFile",
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

  test("an environment row write outside the environment lease is refused", () => {
    const sources = readStorageSources().map((source) => ({
      ...source,
      source: source.source
        .replace(
          `return this.enqueueEnvironmentMutation(async () => {
      const environment = await this.requireEnvironment(environmentId);
      const startupSession = environment.startupAgentSession;`,
          `return (async () => {
      const environment = await this.requireEnvironment(environmentId);
      const startupSession = environment.startupAgentSession;`,
        )
        .replace(
          `this.saveEnvironment(environment);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  async recordEnvironmentActivity(`,
          `this.saveEnvironment(environment);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return environment;
    })();
  }

  async recordEnvironmentActivity(`,
        ),
    }));
    expect(sources.some((source) => source.source.includes("return (async () => {"))).toBe(true);
    const result = analyzeStorageWriters(sources, { rootClass: "StorageService" });
    expect(result.violations.join("\n")).toContain("acknowledgeStartupAgentSession");
  });

  test("agent mail's row diff outside the mail lease is refused", () => {
    const leased = `await this.store.enqueue(async () => {
      // Planned on the shared read model and committed as the rows it changes:`;
    const sources = readStorageSources().map((source) => ({
      ...source,
      source: source.source.replace(
        leased,
        `await (async () => {
      // Planned on the shared read model and committed as the rows it changes:`,
      ),
    }));
    expect(sources.some((source) => source.source.includes(leased))).toBe(false);
    const result = analyzeStorageWriters(sources, { rootClass: "StorageService" });
    expect(
      result.violations.some(
        (violation) =>
          violation.includes("updateStoreRows") &&
          violation.includes("deleteAgentMailByEnvironment"),
      ),
    ).toBe(true);
  });

  describe("prompt queue writers", () => {
    const queueSites = () =>
      analyzeStorageService().sites.filter((site) => site.store === "promptQueuesFile");

    test("every writer is a row write under the queue lease, on every path", () => {
      const sites = queueSites();
      expect(new Set(sites.map((site) => site.call))).toEqual(
        new Set(["context.updateSensitiveStoreRow"]),
      );
      const entries = new Set(
        sites.flatMap((site) => site.paths.map((route) => route.entry?.name ?? "(none)")),
      );
      // The member holding the lease on each path, including both steer paths.
      expect([...entries].sort()).toEqual(
        [
          "acknowledgePromptQueueDispatch",
          "deletePromptQueuesByEnvironment",
          "enqueuePromptQueueMessage",
          "enqueuePromptQueueMessageIfAbsent",
          "failPromptQueueDispatch",
          "markPromptQueueDispatchBoundary",
          "movePromptQueueMessage",
          "removePromptQueueMessage",
          "reserveNativeAgentJobRequest",
          "reservePromptQueueHeadForDispatch",
          "reservePromptQueueSteer",
          "retryPromptQueueDispatch",
          "savePromptQueue",
          "settleNativeAgentJobRequest",
          "settlePromptQueueSteerSource",
        ].sort(),
      );
      for (const site of sites) {
        for (const route of site.paths) {
          expect(route.leases.map((lease) => lease.name)).toContain("promptQueuesFile");
        }
      }
    });

    test("whole-store scans are limited to listings and environment deletion", () => {
      const callers = readStorageSources().flatMap(({ file, source }) =>
        [...source.matchAll(/\b(?:loadPromptQueues|readStoredPromptQueues)\(\)/g)].map((match) => {
          const line = source.slice(0, match.index).split("\n").length;
          return `${path.basename(file)}: ${source.split("\n")[line - 1]!.trim()}`;
        }),
      );
      expect(callers.sort()).toEqual(
        [
          "storage-prompt-queue-store.ts: async loadPromptQueues(): Promise<Record<string, PersistedPromptQueue>> {",
          "storage-prompt-queue-store.ts: const stored = await this.readStoredPromptQueues();",
          "storage-prompt-queue-store.ts: for (const [queueKey, stored] of Object.entries(await this.readStoredPromptQueues())) {",
          "storage-prompt-queue-store.ts: private async readStoredPromptQueues(): Promise<Record<string, unknown>> {",
          "storage-prompts.ts: return Object.values(await this.repos.promptQueues.loadPromptQueues());",
          "storage-prompts.ts: return Object.values(await this.repos.promptQueues.loadPromptQueues()).filter(",
        ].sort(),
      );
    });

    test("a whole-value save brought back beside the row writes is refused", () => {
      const sources = readStorageSources().map((source) => ({
        ...source,
        source: source.source.replace(
          "const removedKeys = await this.repos.promptQueues.deletePromptQueuesOwnedBy(environmentId);",
          `await this.context.saveSensitiveJson(this.files.promptQueuesFile(), {});
      const removedKeys = await this.repos.promptQueues.deletePromptQueuesOwnedBy(environmentId);`,
        ),
      }));
      expect(sources.some((source) => source.source.includes("promptQueuesFile(), {});"))).toBe(
        true,
      );
      const { violations } = analyzeStorageWriters(sources, { rootClass: "StorageService" });
      expect(violations.join("\n")).toContain("promptQueuesFile");
    });

    test("a queue row write outside the queue lease is refused", () => {
      const sources = readStorageSources().map((source) => ({
        ...source,
        source: source.source
          .replace(
            `return this.repos.promptQueues.enqueuePromptQueueMutation(async () => {
      return this.repos.promptQueues.updatePromptQueue<PersistedPromptQueue | null>(
        queueKey,
        (previous) => {
          if (!previous?.dispatchError) return { result: previous ?? null };`,
            `return (async () => {
      return this.repos.promptQueues.updatePromptQueue<PersistedPromptQueue | null>(
        queueKey,
        (previous) => {
          if (!previous?.dispatchError) return { result: previous ?? null };`,
          )
          .replace(
            `return { result: saved, value: saved };
        },
      );
    });
  }

  promptQueueMessageFingerprint(message: unknown): string {`,
            `return { result: saved, value: saved };
        },
      );
    })();
  }

  promptQueueMessageFingerprint(message: unknown): string {`,
          ),
      }));
      expect(sources.some((source) => source.source.includes("return (async () => {"))).toBe(true);
      const { violations } = analyzeStorageWriters(sources, { rootClass: "StorageService" });
      expect(violations.join("\n")).toContain("retryPromptQueueDispatch");
    });
  });

  test("the facade's area fields make their picked members entry points", () => {
    const { areas } = analyzeStorageService();
    expect([...areas.keys()].sort()).toEqual([
      "agentAccounts",
      "agentHandoffs",
      "bugReports",
      "clientState",
      "coordinatorNotices",
      "coordinators",
      "graphDescribe",
      "graphEffects",
      "graphRuns",
      "graphTemplates",
      "kanban",
      "linear",
      "nodes",
      "openCode2Sessions",
      "previewServices",
      "publicOperations",
      "setupApprovals",
      "suborks",
      "ticketSync",
      "watchedPullRequests",
    ]);
    expect(areas.get("kanban")).toContain("KanbanRepository.saveLinearAuth");
    // Sync across machines is its own collaborator sharing the board's lease.
    expect(areas.get("ticketSync")).toContain("KanbanSyncRepository.applyTicketSyncOps");
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

  test(
    "no backend class outside the scan calls the store write primitives",
    () => {
      const { classes } = analyzeStorageService();
      // StorageContext implements them.
      const allowed = new Set([...classes, "StorageContext"]);
      const primitive =
        /^this\.(?:context\.)?(?:saveJson|saveSensitiveJson|deleteStore|updateStore|updateStoreRow|updateSensitiveStoreRow)$/;
      const outside: string[] = [];
      for (const source of backendSources()) {
        if (
          !/\b(?:saveJson|saveSensitiveJson|deleteStore|updateStore|updateStoreRow|updateSensitiveStoreRow)\s*[<(]/.test(
            source.source,
          )
        ) {
          continue;
        }
        const file = parse(source);
        walk(file.program, (node, ancestors) => {
          const callee = node.type === "CallExpression" ? calleePath(node) : null;
          if (!callee || !primitive.test(callee)) return;
          const owner = ancestors.findLast(
            (ancestor) =>
              ancestor.type === "ClassDeclaration" || ancestor.type === "ClassExpression",
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
    },
    WHOLE_TREE_SCAN_TIMEOUT_MS,
  );

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

  test(
    "only the scanned storage classes hold the StorageContext",
    () => {
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
    },
    WHOLE_TREE_SCAN_TIMEOUT_MS,
  );

  test(
    "code outside the storage files reaches the repositories only through StorageService",
    () => {
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
    },
    WHOLE_TREE_SCAN_TIMEOUT_MS,
  );
});
