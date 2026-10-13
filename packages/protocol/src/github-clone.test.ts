import { describe, expect, test } from "bun:test";
import { isGitHubLogin, sortGitHubRepositories, type GitHubCloneRepository } from "./github-clone";

function repository(name: string, updatedAt: string | null): GitHubCloneRepository {
  return {
    name,
    fullName: `acme/${name}`,
    description: null,
    isPrivate: false,
    isFork: false,
    isArchived: false,
    updatedAt,
    cloneUrl: `https://github.com/acme/${name}.git`,
  };
}

describe("isGitHubLogin", () => {
  test("accepts GitHub user and organization names", () => {
    expect(isGitHubLogin("acme")).toBe(true);
    expect(isGitHubLogin("Acme-Labs-2")).toBe(true);
    expect(isGitHubLogin("a".repeat(39))).toBe(true);
  });

  test("rejects names that could be read as flags or paths", () => {
    expect(isGitHubLogin("")).toBe(false);
    expect(isGitHubLogin("-acme")).toBe(false);
    expect(isGitHubLogin("acme-")).toBe(false);
    expect(isGitHubLogin("ac--me")).toBe(false);
    expect(isGitHubLogin("acme/repo")).toBe(false);
    expect(isGitHubLogin("a".repeat(40))).toBe(false);
  });
});

describe("sortGitHubRepositories", () => {
  const repositories = [
    repository("beta", "2026-01-01T00:00:00Z"),
    repository("Alpha", "2025-06-01T00:00:00Z"),
    repository("gamma", null),
    repository("delta", "2026-09-01T00:00:00Z"),
    repository("epsilon", "2026-01-01T00:00:00Z"),
  ];

  test("orders by most recent update, undated last, ties by name", () => {
    expect(sortGitHubRepositories(repositories, "recent").map(({ name }) => name)).toEqual([
      "delta",
      "beta",
      "epsilon",
      "Alpha",
      "gamma",
    ]);
  });

  test("orders alphabetically ignoring case", () => {
    expect(sortGitHubRepositories(repositories, "alphabetical").map(({ name }) => name)).toEqual([
      "Alpha",
      "beta",
      "delta",
      "epsilon",
      "gamma",
    ]);
  });

  test("does not mutate its input", () => {
    const before = repositories.map(({ name }) => name);
    sortGitHubRepositories(repositories, "alphabetical");
    expect(repositories.map(({ name }) => name)).toEqual(before);
  });
});
