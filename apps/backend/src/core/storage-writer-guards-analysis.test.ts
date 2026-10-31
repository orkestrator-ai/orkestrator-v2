import { describe, expect, test } from "bun:test";
import { analyzeStorageWriters } from "./storage-writer-guards-test-support.js";

describe("store writer analysis", () => {
  const base = `
    export class Files {
      readonly dataDir: string = "/data";
      currentKey = "k";
      file(name: string): string { return path.join(this.dataDir, name); }
      aFile(): string { return this.file("a.json"); }
      keyedTarget(): string { return this.file(path.join("keys", this.currentKey)); }
      bFile(): string { return this.file("b.json"); }
    }
    export class Leases {
      constructor(
        private readonly context: StorageContext,
        private readonly files: Files,
      ) {}
      bStore(): string { return this.context.storeForFile(this.files.bFile())!; }
      enqueueA<T>(operation: () => Promise<T>): Promise<T> {
        return this.context.serialize(this.files.aFile(), "a storage", operation);
      }
      enqueueOn<T>(target: string, operation: () => Promise<T>): Promise<T> {
        return this.context.serialize(target, "any storage", operation);
      }
      enqueueViaA<T>(operation: () => Promise<T>): Promise<T> {
        return this.enqueueA(operation);
      }
      enqueueKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
        const digest = hash(key);
        return this.context.serialize(this.files.file(path.join("keys", digest)), "key", operation);
      }
    }
  `;
  const store = (body: string, extra = "") => `${base}
    ${extra}
    export class Store {
      constructor(
        private readonly context: StorageContext,
        private readonly files: Files,
        private readonly leases: Leases,
      ) {}
      ${body}
    }`;
  const analyze = (body: string, extra = "") =>
    analyzeStorageWriters([{ file: "fixture.ts", source: store(body, extra) }], {
      rootClass: "Store",
    });

  test("accepts leased writes through wrappers, parameter targets and helpers", () => {
    const result = analyze(`
      async direct() { return this.leases.enqueueA(async () => { await this.context.saveJson(this.files.aFile(), 1); }); }
      async nested() { return this.leases.enqueueViaA(async () => this.write(2)); }
      async onTarget() { return this.leases.enqueueOn(this.files.aFile(), async () => { await this.write(3); }); }
      private async write(value: number) { await this.context.saveSensitiveJson(this.files.aFile(), value); }
      async rows() { this.context.database.transaction(() => { this.context.database.updateStoreRow(this.leases.bStore(), "k", () => ({ result: 1 })); }); }
    `);
    expect(result.violations).toEqual([]);
    expect(result.classes).toEqual(["Store", "Files", "Leases"]);
    expect(result.stores.get("aFile")).toMatchObject({
      kind: "whole",
      leases: ["aFile"],
      paths: 3,
    });
    expect(result.stores.get("bFile")).toMatchObject({ kind: "transactional" });
  });

  test("rejects an unleased write and a helper with an unleased caller", () => {
    const result = analyze(`
      async save() { await this.context.saveJson(this.files.aFile(), 1); }
      async leased() { return this.leases.enqueueA(async () => this.write(2)); }
      async unleased() { await this.write(3); }
      private async write(value: number) { await this.context.saveJson(this.files.bFile(), value); }
    `);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toContain(
      "no store-wide lease reaches this write from Store.save",
    );
    expect(result.violations[1]).toContain("write ← Store.unleased");
  });

  test("follows a repository's public methods to their callers in other classes", () => {
    const repository = `
      export class Repo {
        constructor(
          private readonly context: StorageContext,
          private readonly files: Files,
        ) {}
        async saveA(value: number) { await this.context.saveJson(this.files.aFile(), value); }
        async orphan() { await this.context.saveJson(this.files.bFile(), 1); }
      }`;
    const leased = analyze(
      `private readonly repo!: Repo;
       async save() { return this.leases.enqueueA(async () => this.repo.saveA(1)); }`,
      repository,
    );
    // A public repository method is not an entry point: its caller holds the lease.
    expect(leased.violations).toEqual([expect.stringContaining("Repo.orphan has no caller")]);
    expect(leased.stores.get("aFile")).toMatchObject({ leases: ["aFile"], paths: 1 });

    const unleased = analyze(
      `private readonly repo!: Repo;
       async save() { await this.repo.saveA(1); }
       async other() { return this.leases.enqueueA(async () => this.repo.orphan()); }`,
      repository,
    );
    expect(unleased.violations).toEqual([expect.stringContaining("saveA ← Store.save")]);
  });

  test("treats the members an area field picks as entry points", () => {
    const repository = `
      export class Repo {
        constructor(
          private readonly context: StorageContext,
          private readonly files: Files,
        ) {}
        async saveA(value: number) { await this.context.saveJson(this.files.aFile(), value); }
        async saveB(value: number) { await this.context.saveJson(this.files.bFile(), value); }
      }
      export type RepoArea = Pick<Repo, "saveA">;`;
    const body = `private readonly repo!: Repo;
       readonly area!: RepoArea;
       async save() { return this.leases.enqueueA(async () => this.repo.saveA(1)); }
       async other() { return this.leases.enqueueA(async () => this.repo.saveB(1)); }`;
    const result = analyze(body, repository);
    // `saveA` is reachable through the area without the root's lease; `saveB`
    // is not picked, so its caller's lease still counts.
    expect(result.violations).toEqual([
      expect.stringContaining("no store-wide lease reaches this write from Repo.saveA"),
    ]);
    expect(result.areas).toEqual(new Map([["area", ["Repo.saveA"]]]));
  });

  test("rejects a public root field exposing a whole class or an unknown pick", () => {
    const repository = `
      export class Repo {
        constructor(private readonly context: StorageContext) {}
        async read() { return 1; }
      }
      export type Missing = Pick<Repo, "write">;`;
    const whole = analyze(`readonly repo!: Repo;`, repository);
    expect(whole.violations).toEqual([
      expect.stringContaining("Store.repo: expose a repository as a Pick of its entry points"),
    ]);
    const copied = analyze(
      `private readonly inner!: Repo;
       readonly alias = this.inner;`,
      repository,
    );
    expect(copied.violations).toEqual([
      expect.stringContaining("Store.alias: expose a repository as a Pick of its entry points"),
    ]);
    const missing = analyze(`readonly area!: Missing;`, repository);
    expect(missing.violations).toEqual([
      expect.stringContaining("Missing: Repo has no public member write"),
    ]);
  });

  test("rejects a class holding a StorageContext the root does not reach", () => {
    const result = analyze(
      `async save() { return this.leases.enqueueA(async () => { await this.context.saveJson(this.files.aFile(), 1); }); }`,
      `export class Stray {
         constructor(private readonly context: StorageContext) {}
         async write() { await this.context.saveJson("x", 1); }
       }`,
    );
    expect(result.violations).toEqual([
      expect.stringContaining("Stray: holds a StorageContext but Store does not reach it"),
    ]);
  });

  test("rejects a scanned class that extends another", () => {
    const result = analyzeStorageWriters(
      [
        {
          file: "fixture.ts",
          source: store("async save() {}").replace(
            "export class Store {",
            "export class Layer {}\nexport class Store extends Layer {",
          ),
        },
      ],
      { rootClass: "Store" },
    );
    expect(result.violations).toEqual([expect.stringContaining("Store: extends Layer")]);
  });

  test("rejects a write held only by one key's lease", () => {
    const result = analyze(`
      async save(key: string) { return this.leases.enqueueKey(key, async () => { await this.context.saveJson(this.files.aFile(), 1); }); }
    `);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('keyed: this.files.file(path.join("keys", digest))');
  });

  test("rejects writers of one store under different leases", () => {
    const result = analyze(`
      async one() { return this.leases.enqueueA(async () => { await this.context.saveJson(this.files.bFile(), 1); }); }
      async two() { return this.leases.enqueueOn(this.files.bFile(), async () => { await this.context.saveJson(this.files.bFile(), 2); }); }
    `);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("bFile: whole-value writers share no lease");
  });

  test("rejects a store written both whole and by transactions", () => {
    const result = analyze(`
      async save() { return this.leases.enqueueA(async () => { await this.context.saveJson(this.files.aFile(), 1); }); }
      async touch() { this.context.updateStore(this.files.aFile(), () => 0, () => undefined); }
    `);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("aFile: written both whole");
  });

  test("treats a transaction inside atomically as a whole-value write", () => {
    const result = analyze(`
      async both() { return this.leases.enqueueA(async () => this.context.atomically(async () => { this.bump(); })); }
      async plain() { this.context.updateStore(this.files.bFile(), () => 0, () => undefined); }
      private bump() { this.context.updateStore(this.files.bFile(), () => 0, () => undefined); }
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
        return this.leases.enqueueA(async () => {
          [1, 2].forEach(async (value) => { await this.context.saveJson(this.files.aFile(), value); });
        });
      }
    `);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("inside a callback of [1, 2].forEach");
  });

  test("rejects a helper passed around as a value", () => {
    const result = analyze(`
      async save() { return this.leases.enqueueA(async () => { const write = this.write; await write(1); }); }
      private async write(value: number) { await this.context.saveJson(this.files.aFile(), value); }
    `);
    expect(result.violations.join("\n")).toContain("write is used without being called");
  });

  test("rejects a store argument it cannot name", () => {
    const result = analyze(`
      async save(file: string) { return this.leases.enqueueA(async () => { await this.context.saveJson(file, 1); }); }
    `);
    expect(result.violations).toEqual([
      expect.stringMatching(
        /^fixture\.ts:\d+ Store\.save: cannot resolve the store written by context\.saveJson$/,
      ),
    ]);
  });

  test("accepts writes and helpers whose result is awaited or returned", () => {
    const result = analyze(`
      async awaited() { return this.leases.enqueueA(async () => { await this.write(1); }); }
      async returned() { return this.leases.enqueueA(async () => { return this.write(2); }); }
      async body() { return this.leases.enqueueA(async () => this.write(3)); }
      async both() { return this.leases.enqueueA(async () => { await Promise.all([this.write(4), this.write(5)]); }); }
      async scoped() { return this.leases.enqueueA(async () => { await this.context.atomically(async () => { await this.write(6); }); }); }
      private async write(value: number) { await waitForExternalWork(); await this.context.saveJson(this.files.aFile(), value); }
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
        async save() { return this.leases.enqueueA(async () => { ${call} }); }
        private async write(value: number) { await waitForExternalWork(); await this.context.saveJson(this.files.aFile(), value); }
      `);
      expect(result.violations).toEqual([
        expect.stringContaining("this.write(...) at fixture.ts:"),
      ]);
      expect(result.violations[0]).toContain("is neither awaited nor returned");
    }
    for (const body of [
      // Inside the callback, inside a helper, and an atomically scope that commits later.
      `async save() { return this.leases.enqueueA(async () => { this.context.saveJson(this.files.aFile(), 1); }); }`,
      `async save() { return this.leases.enqueueA(async () => this.write()); }
       private async write() { await waitForExternalWork(); this.context.saveJson(this.files.aFile(), 1); }`,
      `async save() { return this.leases.enqueueA(async () => { void this.context.atomically(async () => { await this.context.saveJson(this.files.aFile(), 1); }); }); }`,
    ]) {
      const result = analyze(body);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain("is neither awaited nor returned");
    }
  });

  test("rejects a lease taken inside atomically", () => {
    const result = analyze(`
      async save() { return this.context.atomically(async () => this.leases.enqueueA(async () => { await this.context.saveJson(this.files.aFile(), 1); })); }
    `);
    expect(result.violations).toEqual([
      expect.stringContaining("inside a lease taken within this.context.atomically"),
    ]);
  });

  test("rejects a lease wrapper that can run its operation without the lease", () => {
    for (const wrapper of [
      `if (this.files.currentKey === "skip") return operation();
       return this.context.serialize(this.files.aFile(), "a", operation);`,
      `void operation();
       return this.context.serialize(this.files.aFile(), "a", operation);`,
    ]) {
      const result = analyze(`
        private enqueueMaybe<T>(operation: () => Promise<T>): Promise<T> { ${wrapper} }
        async save() { return this.enqueueMaybe(async () => { await this.context.saveJson(this.files.aFile(), 1); }); }
      `);
      expect(result.violations).toEqual([
        expect.stringContaining("inside a callback of this.enqueueMaybe"),
      ]);
    }
  });

  test("treats a lease target as store-wide only when every caller names the same lease", () => {
    for (const target of ["this.files.keyedTarget()", "this.files.file(this.files.currentKey)"]) {
      const result = analyze(`
        async save() { return this.context.serialize(${target}, "k", async () => { await this.context.saveJson(this.files.aFile(), 1); }); }
      `);
      expect(result.violations).toEqual([expect.stringContaining(`keyed: ${target}`)]);
    }
    const fixed = analyze(`
      private fixedTarget(): string { return path.join(this.files.dataDir, "fixed", \`\${"store"}\`); }
      async save() { return this.context.serialize(this.fixedTarget(), "f", async () => { await this.context.saveJson(this.files.aFile(), 1); }); }
    `);
    expect(fixed.violations).toEqual([]);
    expect(fixed.stores.get("aFile")).toMatchObject({ leases: ["fixedTarget"] });
    // The context's own path builder is as stable as its arguments.
    const contextFile = analyze(`
      async save() { return this.context.serialize(this.context.file("a.lock"), "f", async () => { await this.context.saveJson(this.files.aFile(), 1); }); }
    `);
    expect(contextFile.violations).toEqual([]);
  });

  test("follows #private methods and fails writes it cannot follow", () => {
    const leased = analyze(`
      async save() { return this.leases.enqueueA(async () => this.#write()); }
      async #write() { await this.context.saveJson(this.files.aFile(), 1); }
    `);
    expect(leased.violations).toEqual([]);
    expect(leased.stores.get("aFile")).toMatchObject({ leases: ["aFile"] });

    const unleased = analyze(`
      async save() { await this.#write(); }
      async #write() { await this.context.saveJson(this.files.aFile(), 1); }
    `);
    expect(unleased.violations).toEqual([expect.stringContaining("#write ← Store.save")]);

    const computed = analyze(`
      async save() { return this.leases.enqueueA(async () => this["write"]()); }
      async ["write"]() { await this.context.saveJson(this.files.aFile(), 1); }
    `);
    expect(computed.violations).toEqual([
      expect.stringContaining('no store-wide lease reaches this write from Store.["write"]'),
    ]);

    const initializer = analyze(`pending = this.context.saveJson(this.files.aFile(), 1);`);
    expect(initializer.violations).toEqual([
      expect.stringContaining("context.saveJson outside any method the analysis can follow"),
    ]);
  });

  test("lets only constructors pass the StorageContext on", () => {
    const save = `async save() { return this.leases.enqueueA(async () => { await this.context.saveJson(this.files.aFile(), 1); }); }`;
    expect(analyze(save).violations).toEqual([]);
    for (const member of [
      `handle() { return this.context; }`,
      `swap(other: StorageContext) { (this as any).context = other; }`,
    ]) {
      expect(analyze(`${save}\n${member}`).violations).toEqual([
        expect.stringContaining("uses this.context as a value"),
      ]);
    }
    // A constructor hands it to the collaborators it builds.
    expect(
      analyzeStorageWriters(
        [
          {
            file: "fixture.ts",
            source: store(save).replace(
              "      ) {}\n",
              "      ) { this.leases = new Leases(this.context, this.files); }\n",
            ),
          },
        ],
        { rootClass: "Store" },
      ).violations,
    ).toEqual([]);
  });

  test("treats a store deletion as a whole-value write", () => {
    const unleased = analyze(
      `async clear() { await this.context.deleteStore(this.files.aFile()); }`,
    );
    expect(unleased.violations).toEqual([
      expect.stringContaining("no store-wide lease reaches this write from Store.clear"),
    ]);

    const mixed = analyze(`
      async clear() { return this.leases.enqueueA(async () => this.context.deleteStore(this.files.aFile())); }
      async touch() { this.context.updateStore(this.files.aFile(), () => 0, () => undefined); }
    `);
    expect(mixed.violations).toEqual([expect.stringContaining("aFile: written both whole")]);

    const apart = analyze(`
      async save() { return this.leases.enqueueA(async () => { await this.context.saveJson(this.files.bFile(), 1); }); }
      async clear() { return this.leases.enqueueOn(this.files.bFile(), async () => this.context.deleteStore(this.files.bFile())); }
    `);
    expect(apart.violations).toEqual([
      expect.stringContaining("bFile: whole-value writers share no lease"),
    ]);
  });
});
