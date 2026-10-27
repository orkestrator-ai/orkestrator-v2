import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  NativeAgentPermissionRule,
  PermissionRuleApplication,
} from "@orkestrator/protocol/permission-rules";
import { StorageService } from "../storage.js";
import { storageDatabase } from "../storage-test-support.js";
import { PERMISSION_RULES_STORE } from "./layout.js";
import { MAX_PERMISSION_RULE_APPLICATIONS } from "./store.js";

const directories: string[] = [];
const services: StorageService[] = [];

async function openStorage(): Promise<StorageService> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-permission-rules-"));
  directories.push(dataDir);
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  return storage;
}

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function testRule(overrides: Partial<NativeAgentPermissionRule> = {}): NativeAgentPermissionRule {
  return {
    id: "rule-1",
    provider: "codex",
    scope: "project",
    projectId: "project-1",
    kind: "command-prefix",
    pattern: "npm test",
    createdAt: 1_000,
    createdFrom: { environmentId: "env-1", agent: "codex", interactionId: "i-0" },
    useCount: 0,
    ...overrides,
  };
}

function application(
  overrides: Partial<PermissionRuleApplication> = {},
): PermissionRuleApplication {
  return {
    ruleId: "rule-1",
    kind: "command-prefix",
    pattern: "npm test",
    scope: "project",
    environmentId: "env-1",
    agent: "codex",
    logicalSessionKey: "tab-1",
    interactionId: "codex:approval:s:1",
    appliedAt: 2_000,
    ...overrides,
  };
}

describe("PermissionRuleStore", () => {
  test("saves, lists by project and removes rules, announcing each change", async () => {
    const storage = await openStorage();
    const announced: string[] = [];
    storage.addResourceChangeListener((change) => {
      if (change.resource === "permission-rule") announced.push(change.id);
    });
    const store = storage.permissionRuleStore();
    expect(store.list()).toEqual([]);
    store.create(testRule());
    store.create(testRule({ id: "rule-2", projectId: "project-2", pattern: "cargo build" }));
    expect(store.list().map((rule) => rule.id)).toEqual(["rule-1", "rule-2"]);
    expect(store.listForProject("project-2").map((rule) => rule.id)).toEqual(["rule-2"]);
    expect(store.delete("rule-1")).toBe(true);
    expect(store.delete("rule-1")).toBe(false);
    expect(store.list().map((rule) => rule.id)).toEqual(["rule-2"]);
    expect(announced).toEqual(expect.arrayContaining(["rule-1", "rule-2"]));
  });

  test("saving an identical rule returns the saved one with the new expiry", async () => {
    const store = (await openStorage()).permissionRuleStore();
    store.create(testRule({ expiresAt: 5_000 }));
    const again = store.create(testRule({ id: "rule-other", expiresAt: undefined }));
    expect(again.id).toBe("rule-1");
    expect(again.expiresAt).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  test("refuses invalid rules and a full store", async () => {
    const store = (await openStorage()).permissionRuleStore();
    expect(() => store.create(testRule({ pattern: "npm" }))).toThrow();
    expect(() => store.create({ ...testRule(), scope: "host" } as never)).toThrow();
    for (let index = 0; index < 512; index += 1) {
      store.create(testRule({ id: `r-${index}`, pattern: `npm test-${index}` }));
    }
    expect(() => store.create(testRule({ id: "one-more", pattern: "npm run x" }))).toThrow(
      /At most 512/,
    );
  });

  test("an unreadable row answers nothing instead of failing the list", async () => {
    const storage = await openStorage();
    const store = storage.permissionRuleStore();
    store.create(testRule());
    const database = storageDatabase(storage);
    database.transaction(() => {
      database.rows(PERMISSION_RULES_STORE).put("broken", JSON.stringify({ id: "broken" }));
      database
        .rows(PERMISSION_RULES_STORE)
        .put("wide", JSON.stringify(testRule({ id: "wide", pattern: "sudo rm" })));
    });
    expect(store.list().map((rule) => rule.id)).toEqual(["rule-1"]);
  });

  test("a request is claimed once, only while its rule exists and is unexpired", async () => {
    const store = (await openStorage()).permissionRuleStore();
    expect(store.claimApplication(application(), 2_000)).toBe("rule-gone");
    store.create(testRule({ expiresAt: 3_000 }));
    expect(store.claimApplication(application(), 3_000)).toBe("rule-gone");
    expect(store.claimApplication(application(), 2_000)).toBe("claimed");
    expect(store.claimApplication(application(), 2_000)).toBe("duplicate");
    // Only applied answers are listed, and count as a use of the rule.
    expect(store.listApplications()).toEqual([]);
    store.finishApplication(application(), true, 2_500);
    expect(store.listApplications()).toEqual([application()]);
    expect(store.get("rule-1")).toMatchObject({ useCount: 1, lastUsedAt: 2_500 });
    // A second finish of the same claim changes nothing.
    store.finishApplication(application(), true, 2_600);
    expect(store.get("rule-1")).toMatchObject({ useCount: 1, lastUsedAt: 2_500 });
  });

  test("a failed answer is recorded but neither listed nor counted", async () => {
    const store = (await openStorage()).permissionRuleStore();
    store.create(testRule());
    store.claimApplication(application(), 2_000);
    store.finishApplication(application(), false, 2_100);
    expect(store.listApplications()).toEqual([]);
    expect(store.get("rule-1")?.useCount).toBe(0);
    expect(store.claimApplication(application(), 2_200)).toBe("duplicate");
  });

  test("filters applications by environment and session, and bounds the record", async () => {
    const store = (await openStorage()).permissionRuleStore();
    store.create(testRule());
    const other = application({ environmentId: "env-2", interactionId: "x", appliedAt: 1 });
    for (const entry of [application(), other]) {
      store.claimApplication(entry, 2_000);
      store.finishApplication(entry, true, 2_000);
    }
    expect(store.listApplications({ environmentId: "env-2" })).toEqual([other]);
    expect(store.listApplications({ logicalSessionKey: "tab-2" })).toEqual([]);
    for (let index = 0; index < MAX_PERMISSION_RULE_APPLICATIONS + 5; index += 1) {
      store.claimApplication(
        application({ interactionId: `bulk-${index}`, appliedAt: 10_000 + index }),
        2_000,
      );
    }
    expect(store.claimApplication(application({ interactionId: "last" }), 2_000)).toBe("claimed");
  });

  test("deleting an environment removes its environment rules and record, not project rules", async () => {
    const store = (await openStorage()).permissionRuleStore();
    store.create(testRule());
    store.create(
      testRule({ id: "env-rule", scope: "environment", environmentId: "env-1", pattern: "make x" }),
    );
    store.claimApplication(application(), 2_000);
    store.finishApplication(application(), true, 2_000);
    store.environmentDeleted("env-1");
    expect(store.list().map((rule) => rule.id)).toEqual(["rule-1"]);
    expect(store.listApplications()).toEqual([]);
    expect(store.deleteForProject("project-1")).toEqual(["rule-1"]);
    expect(store.list()).toEqual([]);
  });
});
