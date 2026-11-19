import { expect, test } from "bun:test";

import {
  createFixture,
  entry,
  mutation,
  revision,
  targetIdFor,
} from "../mcp-management/test-support.js";
import { mcpManagementInstaller } from "./index.js";

test("managed MCP updates and removal require the installed native definition", async () => {
  const fixture = createFixture({ env: {} });
  try {
    const installer = mcpManagementInstaller(() => fixture.service);
    const provider = "claude";
    const sourceId = "claude:user";
    const name = "capability-docs";
    const targetId = await targetIdFor(fixture, provider, "backend");
    const initial = await installer.install({
      provider,
      name,
      definition: { transport: "http", url: "https://example.com/one" },
      requestId: "initial",
    });
    expect(initial.status).toBe("installed-next-session");
    expect(initial.ownership).toBeDefined();
    const updated = await installer.install({
      provider,
      name,
      definition: { transport: "http", url: "https://example.com/two" },
      requestId: "update",
      previous: initial.ownership!,
    });
    expect(updated.status).toBe("installed-next-session");
    expect(updated.ownership?.fingerprint).not.toBe(initial.ownership?.fingerprint);
    expect(await installer.observe!(updated.ownership!)).toBe("present");

    const snapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(snapshot, sourceId, name).entryId,
        expectedRevision: revision(snapshot, sourceId)!,
        patch: { url: { kind: "set", value: "https://example.com/local" } },
      }),
    );
    expect(await installer.observe!(updated.ownership!)).toBe("drifted");
    const removed = await installer.remove({
      provider,
      name,
      requestId: "remove",
      previous: updated.ownership!,
    });
    expect(removed.status).toBe("drifted");
    const final = await fixture.service.snapshot({ targetId });
    expect(entry(final, sourceId, name)).toBeDefined();
  } finally {
    await fixture.cleanup();
  }
});
