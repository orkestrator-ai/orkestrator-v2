import { describe, expect, test } from "bun:test";
import { GitHubIssueDetail, GitHubIssuesView } from "./index";

describe("GitHub component exports", () => {
  test("publishes the issue board and detail", () => {
    expect(typeof GitHubIssueDetail).toBe("function");
    expect(typeof GitHubIssuesView).toBe("function");
  });
});
