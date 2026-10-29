import { expect, test } from "bun:test";
import {
  repositoryHint,
  toNodeProjectSummary,
  toNodeEnvironmentSummary,
} from "./node-summaries.js";
import { classifyRouteFailure } from "./node/node-link/routes.js";

test("repository identities retain namespaces and ports and normalize HTTPS/SCP remotes", () => {
  const first = "https://gitlab.example/team-a/shared/app.git";
  const second = "https://gitlab.example/team-b/shared/app.git";
  expect(repositoryHint(first)).toBe("gitlab.example/team-a/shared/app");
  expect(repositoryHint(first)).toBe(repositoryHint("git@gitlab.example:team-a/shared/app.git"));
  expect(repositoryHint(first)).not.toBe(repositoryHint(second));
  expect(repositoryHint("ssh://git@gitlab.example:2222/team-a/shared/app.git")).not.toBe(
    repositoryHint(first),
  );
  expect(
    toNodeProjectSummary("bk_test" as never, { id: "p", gitUrl: first }, 0)?.repositoryHint,
  ).toBe(repositoryHint(first));
});

test("raw and wrapped TLS verification failures quarantine without fallback", () => {
  for (const code of [
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]) {
    const raw = Object.assign(new Error("fetch failed"), { code });
    for (const error of [
      raw,
      new TypeError("fetch failed", { cause: raw }),
      Object.assign(new Error("unreachable"), { code: "unreachable", retryable: true, cause: raw }),
    ]) {
      expect(classifyRouteFailure(error)).toMatchObject({
        quarantine: true,
        retryable: false,
        state: "trust-blocked",
      });
    }
  }
});

test("environment summaries use finite owner order or the storage index fallback", () => {
  const raw = { id: "e", projectId: "p" };
  expect(toNodeEnvironmentSummary("bk_test" as never, { ...raw, order: -3 }, 8)?.order).toBe(-3);
  for (const order of [undefined, null, "2", NaN, Infinity, -Infinity]) {
    expect(toNodeEnvironmentSummary("bk_test" as never, { ...raw, order }, 8)?.order).toBe(8);
    expect(toNodeProjectSummary("bk_test" as never, { ...raw, order }, 8)?.order).toBe(8);
  }
  expect(toNodeEnvironmentSummary("bk_test" as never, raw)?.order).toBe(0);
});

test("search fields are bounded, path-free and additive", () => {
  const project = toNodeProjectSummary(
    "bk_test" as never,
    {
      id: "p",
      name: "telegram-scraper",
      localPath: "C:\\Users\\someone\\code\\telegram-scraper\\",
      defaultBranch: ` ${"b".repeat(400)} `,
    },
    0,
  )!;
  expect(project.pathName).toBe("telegram-scraper");
  expect(project.defaultBranch).toHaveLength(256);
  const environment = toNodeEnvironmentSummary("bk_test" as never, {
    id: "e",
    projectId: "p",
    worktreePath: `/tmp/${"w".repeat(300)}`,
    createdAt: "2026-10-01T00:00:00.000Z".padEnd(100, "Z"),
  })!;
  expect(environment.worktreeName).toHaveLength(128);
  expect(environment.createdAt).toHaveLength(64);
  // Older summaries and records without the fields simply omit them.
  const bare = toNodeProjectSummary("bk_test" as never, { id: "p", localPath: "/" }, 0)!;
  expect(Object.keys(bare)).not.toContain("pathName");
  expect(Object.keys(bare)).not.toContain("defaultBranch");
  const bareEnvironment = toNodeEnvironmentSummary("bk_test" as never, {
    id: "e",
    projectId: "p",
  })!;
  expect(Object.keys(bareEnvironment)).not.toContain("worktreeName");
  expect(Object.keys(bareEnvironment)).not.toContain("createdAt");
});

test("PR readiness signals travel without the PR URL and drop anything unrecognised", () => {
  const environment = toNodeEnvironmentSummary("bk_test" as never, {
    id: "e",
    projectId: "p",
    prUrl: "https://github.com/acme/private/pull/7",
    prState: "open",
    hasMergeConflicts: false,
    prMergeability: "clean",
  })!;
  expect(environment).toMatchObject({
    prState: "open",
    prHasMergeConflicts: false,
    prMergeability: "clean",
  });
  expect(JSON.stringify(environment)).not.toContain("github.com");

  const malformed = toNodeEnvironmentSummary("bk_test" as never, {
    id: "e",
    projectId: "p",
    prState: "OPEN",
    hasMergeConflicts: "no",
    prMergeability: "CLEAN",
  })!;
  expect(Object.keys(malformed)).not.toContain("prState");
  expect(Object.keys(malformed)).not.toContain("prHasMergeConflicts");
  expect(Object.keys(malformed)).not.toContain("prMergeability");

  // A record from a node without a PR (or before the fields) omits them.
  const bare = toNodeEnvironmentSummary("bk_test" as never, {
    id: "e",
    projectId: "p",
    prState: null,
    hasMergeConflicts: null,
    prMergeability: null,
  })!;
  for (const key of ["prState", "prHasMergeConflicts", "prMergeability"]) {
    expect(Object.keys(bare)).not.toContain(key);
  }
});

test("a project's icon is carried only as a bounded raster data URL", () => {
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  expect(toNodeProjectSummary("bk_test" as never, { id: "p", icon }, 0)?.icon).toBe(icon);
  for (const value of ["data:image/svg+xml;base64,PHN2Zz4=", "https://x/icon.png", 3, null]) {
    const project = toNodeProjectSummary("bk_test" as never, { id: "p", icon: value }, 0);
    expect(project && "icon" in project).toBe(false);
  }
});
