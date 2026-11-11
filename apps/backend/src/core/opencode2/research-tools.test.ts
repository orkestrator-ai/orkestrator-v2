import { afterEach, describe, expect, test } from "bun:test";
import { fixtureMcpServer } from "./research-server.test-support.js";
import { listOpenCodeResearchTools, openCodeResearchToolIds } from "./research-tools.js";

describe("OpenCode coordinator research tool ids", () => {
  test("names each tool as OpenCode registers it", () => {
    expect(openCodeResearchToolIds("context7", ["resolve-library-id", "query.docs"], [])).toEqual([
      "context7_resolve-library-id",
      "context7_query_docs",
    ]);
  });

  test("leaves out a tool a longer-named project server could also produce", () => {
    // `context7_a` + `b` and `context7` + `a_b` are both `context7_a_b`.
    expect(
      openCodeResearchToolIds("context7", ["a_b", "query-docs"], ["context7_a", "docs"]),
    ).toEqual(["context7_query-docs"]);
  });
});

describe("listOpenCodeResearchTools", () => {
  const servers: Array<{ stop(): void }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  test("lists the research server's own tool names", async () => {
    const server = fixtureMcpServer(["resolve-library-id", " query-docs ", ""]);
    servers.push(server);
    expect(await listOpenCodeResearchTools(server.url.href)).toEqual([
      "resolve-library-id",
      "query-docs",
    ]);
    expect(server.requests()).toBeGreaterThan(0);
  });
});
