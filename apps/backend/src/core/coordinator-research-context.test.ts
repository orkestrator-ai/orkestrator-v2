import { describe, expect, test } from "bun:test";
import {
  coordinatorResearchLine,
  loadCoordinatorResearch,
} from "./coordinator-research-context.js";
import type { AppConfig } from "./models.js";

const config = (global: Partial<AppConfig["global"]>) =>
  ({ global, repositories: [] }) as unknown as AppConfig;

describe("coordinator research context", () => {
  test("reads the setting with its defaults, and fails closed when it cannot", async () => {
    expect(await loadCoordinatorResearch({ loadConfig: async () => config({}) })).toEqual({
      mode: "search-and-mcp",
      servers: [{ name: "context7", url: "https://mcp.context7.com/mcp" }],
    });
    expect(
      await loadCoordinatorResearch({
        loadConfig: async () => config({ coordinatorWebResearch: "search" }),
      }),
    ).toMatchObject({ mode: "search" });
    // A malformed mode is not a widening.
    expect(
      await loadCoordinatorResearch({
        loadConfig: async () => config({ coordinatorWebResearch: "live" as never }),
      }),
    ).toMatchObject({ mode: "off" });
    expect(
      await loadCoordinatorResearch({
        loadConfig: async () => {
          throw new Error("unreadable");
        },
      }),
    ).toEqual({ mode: "off", servers: [] });
    expect(await loadCoordinatorResearch({})).toEqual({ mode: "off", servers: [] });
  });

  test("tells the agent what it may use, and that page fetches are off in every mode", () => {
    const off = coordinatorResearchLine({ mode: "off", servers: [] });
    expect(off).toContain("fetching live web pages is off");
    expect(off).toContain("Web search and research servers are also off");

    const search = coordinatorResearchLine({ mode: "search", servers: [] });
    expect(search).toContain("fetching live web pages is off");
    expect(search).toContain("your web search tool");
    expect(search).not.toContain("research MCP servers");

    const mcp = coordinatorResearchLine({
      mode: "search-and-mcp",
      servers: [{ name: "context7", url: "https://mcp.context7.com/mcp" }],
    });
    expect(mcp).toContain("the research MCP servers context7");
    expect(mcp).toContain("not as a substitute for delegating work");
  });
});
