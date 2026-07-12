import { describe, test, expect } from "bun:test";
import { isValidGitUrl, extractRepoName, normalizeGitUrl } from "../../../apps/web/src/lib/gitUrl";

describe("gitUrl utilities", () => {
  describe("isValidGitUrl", () => {
    test("validates SSH URLs", () => {
      expect(isValidGitUrl("git@github.com:user/repo.git")).toBe(true);
      expect(isValidGitUrl("git@github.com:user/repo")).toBe(true);
      expect(isValidGitUrl("git@gitlab.com:org/project.git")).toBe(true);
      expect(isValidGitUrl("git@bitbucket.org:team/repo.git")).toBe(true);
    });

    test("validates HTTPS URLs", () => {
      expect(isValidGitUrl("https://github.com/user/repo.git")).toBe(true);
      expect(isValidGitUrl("https://github.com/user/repo")).toBe(true);
      expect(isValidGitUrl("https://gitlab.com/org/project.git")).toBe(true);
      expect(isValidGitUrl("http://github.com/user/repo.git")).toBe(true);
    });

    test("rejects invalid URLs", () => {
      expect(isValidGitUrl("")).toBe(false);
      expect(isValidGitUrl("   ")).toBe(false);
      expect(isValidGitUrl("not-a-url")).toBe(false);
      expect(isValidGitUrl("ftp://github.com/repo")).toBe(false);
      expect(isValidGitUrl("user/repo")).toBe(false);
    });
  });

  describe("extractRepoName", () => {
    test("extracts name from SSH URLs", () => {
      expect(extractRepoName("git@github.com:user/myrepo.git")).toBe("myrepo");
      expect(extractRepoName("git@github.com:user/myrepo")).toBe("myrepo");
      expect(extractRepoName("git@github.com:org/project-name.git")).toBe("project-name");
    });

    test("extracts name from HTTPS URLs", () => {
      expect(extractRepoName("https://github.com/user/myrepo.git")).toBe("myrepo");
      expect(extractRepoName("https://github.com/user/myrepo")).toBe("myrepo");
      expect(extractRepoName("https://gitlab.com/org/my-project.git")).toBe("my-project");
    });

    test("handles edge cases", () => {
      // For bare strings without slashes or colons, returns as-is
      expect(extractRepoName("myrepo")).toBe("myrepo");
      // For full paths with directories
      expect(extractRepoName("/path/to/myrepo.git")).toBe("myrepo");
    });
  });

  describe("normalizeGitUrl", () => {
    test("removes .git suffix", () => {
      expect(normalizeGitUrl("https://github.com/user/repo.git")).toBe(
        "https://github.com/user/repo"
      );
      expect(normalizeGitUrl("git@github.com:user/repo.git")).toBe(
        "git@github.com:user/repo"
      );
    });

    test("lowercases the URL", () => {
      expect(normalizeGitUrl("https://GitHub.com/User/Repo")).toBe(
        "https://github.com/user/repo"
      );
    });

    test("trims whitespace", () => {
      expect(normalizeGitUrl("  https://github.com/user/repo  ")).toBe(
        "https://github.com/user/repo"
      );
    });
  });
});
