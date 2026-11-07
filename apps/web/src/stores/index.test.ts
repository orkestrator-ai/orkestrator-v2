import { describe, expect, test } from "bun:test";
import {
  agentModelCatalogStore,
  buildPipelineStore,
  githubIssuesStore,
  kanbanStore,
  useAgentModelCatalogStore,
  useBuildPipelineStore,
  useGitHubIssuesStore,
  useKanbanStore,
} from "./index";

describe("store exports", () => {
  test("publishes the GitHub and build stores through the shared barrel", () => {
    expect(useBuildPipelineStore.def).toBe(buildPipelineStore);
    expect(useGitHubIssuesStore.def).toBe(githubIssuesStore);
    expect(useKanbanStore.def).toBe(kanbanStore);
    expect(useAgentModelCatalogStore.def).toBe(agentModelCatalogStore);
  });
});
