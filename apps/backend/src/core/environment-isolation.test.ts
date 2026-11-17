import { describe, expect, test } from "bun:test";
import {
  chooseEnvironmentPortBase,
  ENVIRONMENT_ISOLATION_ENV_NAMES,
  ENVIRONMENT_PORT_BLOCK_COUNT,
  ENVIRONMENT_PORT_BLOCK_SIZE,
  ENVIRONMENT_PORT_RANGE_END,
  ENVIRONMENT_PORT_RANGE_START,
  environmentComposeProjectName,
  environmentIsolationVariables,
  formatEnvironmentIsolationNotice,
  isEnvironmentPortBase,
  localEnvironmentIsolationEnv,
  withEnvironmentIsolation,
  environmentIsolationShellPrefix,
} from "./environment-isolation.js";
import { createEnvironment } from "./storage-shared-core.js";
import { withTemporaryStorage } from "./storage-test-support.js";

const ID = "3f2a9c1e-77b4-4d1a-9e0f-0123456789ab";

describe("port blocks", () => {
  test("every block lies in the reserved range, aligned to the block size", () => {
    expect(ENVIRONMENT_PORT_BLOCK_COUNT).toBe(600);
    const base = chooseEnvironmentPortBase(ID, new Set());
    expect(isEnvironmentPortBase(base)).toBe(true);
    expect(base! + ENVIRONMENT_PORT_BLOCK_SIZE).toBeLessThanOrEqual(ENVIRONMENT_PORT_RANGE_END);
    for (const value of [
      ENVIRONMENT_PORT_RANGE_START - ENVIRONMENT_PORT_BLOCK_SIZE,
      ENVIRONMENT_PORT_RANGE_START + 1,
      ENVIRONMENT_PORT_RANGE_END,
      Number.NaN,
      "20000",
    ]) {
      expect(isEnvironmentPortBase(value)).toBe(false);
    }
  });

  test("the choice is stable per environment and skips taken blocks", () => {
    const first = chooseEnvironmentPortBase(ID, new Set());
    expect(chooseEnvironmentPortBase(ID, new Set())).toBe(first);
    const next = chooseEnvironmentPortBase(ID, new Set([first!]));
    expect(next).not.toBe(first);
    expect(isEnvironmentPortBase(next)).toBe(true);
  });

  test("returns null once every block is taken", () => {
    const all = new Set<number>();
    for (let index = 0; index < ENVIRONMENT_PORT_BLOCK_COUNT; index += 1) {
      all.add(ENVIRONMENT_PORT_RANGE_START + index * ENVIRONMENT_PORT_BLOCK_SIZE);
    }
    expect(chooseEnvironmentPortBase(ID, all)).toBeNull();
  });
});

describe("isolation variables", () => {
  test("names a valid Compose project from the id, not the display name", () => {
    expect(environmentComposeProjectName(ID)).toBe("ork-3f2a9c1e77b4");
    expect(environmentComposeProjectName("Env_ONE!")).toBe("ork-envone");
    expect(environmentComposeProjectName("---")).toBe("ork-env");
    expect(environmentComposeProjectName(ID)).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });

  test("sets the port variables only with a block", () => {
    expect(environmentIsolationVariables(ID, 20_100)).toEqual({
      ORKESTRATOR_ENVIRONMENT_ID: ID,
      COMPOSE_PROJECT_NAME: "ork-3f2a9c1e77b4",
      ORKESTRATOR_PORT_BASE: "20100",
      ORKESTRATOR_PORT_COUNT: "20",
      ORKESTRATOR_PORT_MAX: "20119",
    });
    expect(environmentIsolationVariables(ID, null)).toEqual({
      ORKESTRATOR_ENVIRONMENT_ID: ID,
      COMPOSE_PROJECT_NAME: "ork-3f2a9c1e77b4",
    });
    expect([...ENVIRONMENT_ISOLATION_ENV_NAMES].sort()).toEqual(
      Object.keys(environmentIsolationVariables(ID, 20_100)).sort(),
    );
  });

  test("the setup notice names the project and the range", () => {
    expect(formatEnvironmentIsolationNotice(environmentIsolationVariables(ID, 20_100))).toBe(
      "[orkestrator] Isolation: Docker Compose project ork-3f2a9c1e77b4 ($COMPOSE_PROJECT_NAME), host ports 20100-20119 ($ORKESTRATOR_PORT_BASE-$ORKESTRATOR_PORT_MAX)",
    );
    expect(formatEnvironmentIsolationNotice(environmentIsolationVariables(ID, null))).toContain(
      "no reserved host ports",
    );
  });
});

test("a launch replaces all inherited isolation keys without mutating its parent", () => {
  const parent: NodeJS.ProcessEnv = {
    ...environmentIsolationVariables("parent", 20_000),
    PATH: "/bin",
  };
  expect(withEnvironmentIsolation(parent)).toEqual({ PATH: "/bin" });
  expect(withEnvironmentIsolation(parent, environmentIsolationVariables(ID, null))).toEqual({
    PATH: "/bin",
    ORKESTRATOR_ENVIRONMENT_ID: ID,
    COMPOSE_PROJECT_NAME: environmentComposeProjectName(ID),
  });
  expect(parent.ORKESTRATOR_PORT_BASE).toBe("20000");
  expect(environmentIsolationShellPrefix({})).toBe(
    `unset ${ENVIRONMENT_ISOLATION_ENV_NAMES.join(" ")}; `,
  );
});

describe("reserving a block", () => {
  test("each local environment keeps its own block", async () => {
    await withTemporaryStorage(async (storage) => {
      const first = await storage.addEnvironment(
        createEnvironment("project-a", { environmentType: "local", name: "one" }),
      );
      const second = await storage.addEnvironment(
        createEnvironment("project-b", { environmentType: "local", name: "two" }),
      );
      const [a, b] = await Promise.all([
        storage.environmentIsolation.assignEnvironmentPortBase(first.id),
        storage.environmentIsolation.assignEnvironmentPortBase(second.id),
      ]);
      expect(isEnvironmentPortBase(a)).toBe(true);
      expect(isEnvironmentPortBase(b)).toBe(true);
      expect(a).not.toBe(b);
      // Kept on the record, so a restart keeps the same ports.
      expect((await storage.getEnvironment(first.id))?.isolationPortBase).toBe(a!);
      expect(await storage.environmentIsolation.assignEnvironmentPortBase(first.id)).toBe(a);

      await storage.removeEnvironment(first.id);
      expect(await storage.environmentIsolation.assignEnvironmentPortBase(first.id)).toBeNull();
      const third = await storage.addEnvironment(
        createEnvironment("project-a", { environmentType: "local", name: "three" }),
      );
      expect(await storage.environmentIsolation.assignEnvironmentPortBase(third.id)).not.toBe(b);
    });
  });

  test("a block two records share is given up by the one that asks first", async () => {
    await withTemporaryStorage(async (storage) => {
      const first = await storage.addEnvironment({
        ...createEnvironment("project-a", { environmentType: "local", name: "one" }),
        isolationPortBase: 20_000,
      });
      const second = await storage.addEnvironment({
        ...createEnvironment("project-a", { environmentType: "local", name: "two" }),
        isolationPortBase: 20_000,
      });
      const moved = await storage.environmentIsolation.assignEnvironmentPortBase(first.id);
      expect(moved).not.toBe(20_000);
      expect(isEnvironmentPortBase(moved)).toBe(true);
      expect(await storage.environmentIsolation.assignEnvironmentPortBase(second.id)).toBe(20_000);
    });
  });

  test("a container environment gets no variables; a local one gets its block", async () => {
    await withTemporaryStorage(async (storage) => {
      const container = await storage.addEnvironment(createEnvironment("project-a"));
      expect(await localEnvironmentIsolationEnv(container, storage)).toEqual({});
      expect((await storage.getEnvironment(container.id))?.isolationPortBase).toBeUndefined();

      const local = await storage.addEnvironment(
        createEnvironment("project-a", { environmentType: "local" }),
      );
      const variables = await localEnvironmentIsolationEnv(local, storage);
      const stored = await storage.getEnvironment(local.id);
      expect(variables.ORKESTRATOR_PORT_BASE).toBe(String(stored?.isolationPortBase));
      expect(variables.COMPOSE_PROJECT_NAME).toBe(environmentComposeProjectName(local.id));
    });
  });

  test("a failed reservation still isolates the Compose project", async () => {
    const variables = await localEnvironmentIsolationEnv(
      { id: ID, environmentType: "local" },
      {
        environmentIsolation: {
          assignEnvironmentPortBase: () => Promise.reject(new Error("storage closed")),
        },
      },
    );
    expect(variables).toEqual(environmentIsolationVariables(ID, null));
  });
});
