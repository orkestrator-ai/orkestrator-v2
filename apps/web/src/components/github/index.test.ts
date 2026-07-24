import { describe, expect, test } from "bun:test";
import {
  GitHubIssueDetail,
  GitHubIssuesView,
  GitHubPipelineCompletionMonitor,
} from "./index";

describe("GitHub component exports", () => {
  test("publishes the issue board, detail, and completion monitor", () => {
    expect(typeof GitHubIssueDetail).toBe("function");
    expect(typeof GitHubIssuesView).toBe("function");
    expect(typeof GitHubPipelineCompletionMonitor).toBe("function");
  });
});
