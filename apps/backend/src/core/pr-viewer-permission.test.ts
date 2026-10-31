import { describe, expect, test } from "bun:test";
import {
  isMergePermissionError,
  parsePrViewerPermission,
  PR_VIEWER_PERMISSION_RETRY_MS,
  PR_VIEWER_PERMISSION_TTL_MS,
  prViewerPermissionArgs,
  prViewerPermissionScope,
  prViewerRepository,
  PrViewerPermissionCache,
} from "./pr-viewer-permission.js";
import type { PrMonitorTarget } from "./pr-monitor.js";

const REPO = { host: "github.com", owner: "acme", repo: "widgets" };

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("prViewerRepository", () => {
  test("reads a github.com PR URL", () => {
    expect(prViewerRepository("https://github.com/acme/widgets/pull/7")).toEqual(REPO);
  });

  test.each([
    null,
    "",
    "not a url",
    "http://github.com/acme/widgets/pull/7",
    "https://ghe.example.com/acme/widgets/pull/7",
    "https://github.com/acme/widgets/issues/7",
    "https://github.com/acme/wid%2Fgets/pull/7",
  ])("ignores %p", (url) => {
    expect(prViewerRepository(url)).toBeNull();
  });
});

describe("prViewerPermissionScope", () => {
  const base: PrMonitorTarget = {
    environmentId: "env-1",
    branch: "feature",
    kind: "local",
    ready: true,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
  };

  test("local environments share the host login; each container is its own", () => {
    expect(prViewerPermissionScope(base)).toBe("local-gh");
    expect(prViewerPermissionScope({ ...base, kind: "container", containerId: "c1" })).toBe(
      "container:c1",
    );
    expect(prViewerPermissionScope({ ...base, kind: "container" })).toBeNull();
  });
});

describe("parsePrViewerPermission", () => {
  test.each([
    [{ admin: false, maintain: false, push: true, triage: true, pull: true }, true],
    [{ admin: false, maintain: true, push: false, pull: true }, true],
    [{ admin: true, push: false }, true],
    [{ admin: false, maintain: false, push: false, triage: true, pull: true }, false],
  ])("%p may merge: %p", (permissions, expected) => {
    expect(parsePrViewerPermission(`${JSON.stringify(permissions)}\n`)).toBe(expected);
  });

  test("throws when GitHub reported no permissions, so the answer stays unknown", () => {
    expect(() => parsePrViewerPermission("null\n")).toThrow();
    expect(() => parsePrViewerPermission("")).toThrow();
    expect(() => parsePrViewerPermission("[]")).toThrow();
    expect(() => parsePrViewerPermission("{}")).toThrow();
    expect(() => parsePrViewerPermission('{"push":"false"}')).toThrow();
  });

  test("asks the exact repository on its host", () => {
    expect(prViewerPermissionArgs(REPO)).toEqual([
      "api",
      "--hostname",
      "github.com",
      "repos/acme/widgets",
      "--jq",
      ".permissions",
    ]);
  });
});

describe("isMergePermissionError", () => {
  test.each([
    "gh: Must have admin rights to Repository. (HTTP 403)",
    "HTTP 403: Resource not accessible by integration",
    "GraphQL: octo does not have the correct permissions to execute `MergePullRequest`",
    "Resource not accessible by personal access token",
  ])("recognises %p", (message) => {
    expect(isMergePermissionError(new Error(message))).toBe(true);
  });

  test.each([
    "Pull Request is not mergeable (HTTP 405)",
    "Head branch was modified. Review and try the merge again. (HTTP 409)",
    "timed out",
  ])("ignores %p", (message) => {
    expect(isMergePermissionError(new Error(message))).toBe(false);
  });
});

describe("PrViewerPermissionCache", () => {
  test("asks once per scope and repository within the hour", async () => {
    const time = clock();
    const cache = new PrViewerPermissionCache(time.now);
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return true;
    };
    expect(await cache.resolve("local-gh", REPO, fetch)).toBe(true);
    time.advance(PR_VIEWER_PERMISSION_TTL_MS - 1);
    expect(await cache.resolve("local-gh", REPO, fetch)).toBe(true);
    expect(calls).toBe(1);
    // Another credential scope asks for itself.
    expect(await cache.resolve("container:c1", REPO, fetch)).toBe(true);
    expect(calls).toBe(2);
    time.advance(1);
    expect(await cache.resolve("local-gh", REPO, fetch)).toBe(true);
    expect(calls).toBe(3);
  });

  test("repository names compare case-insensitively", async () => {
    const cache = new PrViewerPermissionCache(clock().now);
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return false;
    };
    await cache.resolve("local-gh", REPO, fetch);
    expect(await cache.resolve("local-gh", { ...REPO, owner: "ACME" }, fetch)).toBe(false);
    expect(calls).toBe(1);
  });

  test("concurrent callers share one lookup", async () => {
    const cache = new PrViewerPermissionCache(clock().now);
    let calls = 0;
    let release!: (value: boolean) => void;
    const fetch = () => {
      calls += 1;
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    };
    const first = cache.resolve("local-gh", REPO, fetch);
    const second = cache.resolve("local-gh", REPO, fetch);
    await Promise.resolve();
    release(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(calls).toBe(1);
  });

  test("a failed lookup is unknown and retried sooner than a known answer", async () => {
    const time = clock();
    const cache = new PrViewerPermissionCache(time.now);
    let calls = 0;
    const failing = async (): Promise<boolean> => {
      calls += 1;
      throw new Error("HTTP 502");
    };
    expect(await cache.resolve("local-gh", REPO, failing)).toBeNull();
    time.advance(PR_VIEWER_PERMISSION_RETRY_MS - 1);
    expect(await cache.resolve("local-gh", REPO, failing)).toBeNull();
    expect(calls).toBe(1);
    time.advance(1);
    expect(await cache.resolve("local-gh", REPO, async () => false)).toBe(false);
  });

  test("invalidate makes the next caller ask again", async () => {
    const cache = new PrViewerPermissionCache(clock().now);
    await cache.resolve("local-gh", REPO, async () => true);
    cache.invalidate("local-gh", REPO);
    expect(await cache.resolve("local-gh", REPO, async () => false)).toBe(false);
  });

  test("a lookup superseded by invalidate does not store its answer", async () => {
    const cache = new PrViewerPermissionCache(clock().now);
    let release!: (value: boolean) => void;
    const stale = cache.resolve(
      "local-gh",
      REPO,
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    cache.invalidate("local-gh", REPO);
    release(true);
    expect(await stale).toBeNull();
    expect(cache.size).toBe(0);
  });

  test("expired scopes are dropped on the next miss", async () => {
    const time = clock();
    const cache = new PrViewerPermissionCache(time.now);
    await cache.resolve("container:old", REPO, async () => true);
    time.advance(PR_VIEWER_PERMISSION_TTL_MS);
    await cache.resolve("container:new", REPO, async () => true);
    expect(cache.size).toBe(1);
  });
});

for (const scope of ["local-gh", "container:c1"]) {
  test.each([true, false])(
    `${scope} credential rotation supersedes cached and in-flight answers (%p)`,
    async (oldPermission) => {
      const cache = new PrViewerPermissionCache();
      const other = { ...REPO, repo: "other" };
      await cache.resolve(scope, REPO, async () => oldPermission);
      let release!: (value: boolean) => void;
      const stale = cache.resolve(
        scope,
        other,
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      );
      await Promise.resolve();
      await cache.rotateScope(scope, async () => undefined);
      let calls = 0;
      const fresh = async () => {
        calls += 1;
        return !oldPermission;
      };
      expect(await cache.resolve(scope, REPO, fresh)).toBe(!oldPermission);
      expect(await cache.resolve(scope, other, fresh)).toBe(!oldPermission);
      release(oldPermission);
      expect(await stale).toBeNull();
      expect(await cache.resolve(scope, other, fresh)).toBe(!oldPermission);
      expect(calls).toBe(2);
    },
  );
}

test("scope rotation invalidates reads started during a failed credential write and preserves other scopes", async () => {
  const cache = new PrViewerPermissionCache();
  await cache.resolve("container:other", REPO, async () => true);
  await expect(
    cache.rotateScope("local-gh", async () => {
      expect(await cache.resolve("local-gh", REPO, async () => false)).toBe(false);
      throw new Error("credential write failed");
    }),
  ).rejects.toThrow("credential write failed");
  expect(await cache.resolve("local-gh", REPO, async () => true)).toBe(true);
  expect(await cache.resolve("container:other", REPO, async () => false)).toBe(true);
});
