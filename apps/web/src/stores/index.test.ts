import { describe, expect, test } from "bun:test";
import {
  useBuildPipelineStore,
  useGitHubIssuesStore,
  useKanbanStore,
} from "./index";

describe("store exports", () => {
  test("publishes the GitHub and build stores through the shared barrel", () => {
    expect(typeof useBuildPipelineStore.getState).toBe("function");
    expect(typeof useGitHubIssuesStore.getState).toBe("function");
    expect(typeof useKanbanStore.getState).toBe("function");
  });
});
