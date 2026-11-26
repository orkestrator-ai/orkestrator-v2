import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { MCP_MANAGEMENT_CHANGED_EVENT } from "@orkestrator/protocol/mcp-management";
import type { CommandContext } from "../commands/index.js";

import {
  createFixture,
  entry,
  mutation,
  revision,
  targetIdFor,
} from "../mcp-management/test-support.js";
import { capabilityHomes, mcpManagementInstaller, setCapabilityPluginEnabled } from "./index.js";
import { InventoryPluginCache } from "./inventory-cache.js";

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

test("MCP host saves and detected edits invalidate listings while Apply shares the pending read", async () => {
  const pending = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let reads = 0;
  const cache = new InventoryPluginCache(async () => {
    reads += 1;
    if (reads === 1) {
      started.resolve();
      await pending.promise;
    }
    return { plugins: [] };
  });
  const fixture = createFixture({ onHostConfigChange: () => cache.invalidate() });
  try {
    const targetId = await targetIdFor(fixture, "codex", "backend");
    const sourceId = "codex:user";
    const initial = await fixture.service.snapshot({ targetId });
    const added = await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId,
        expectedRevision: revision(initial, sourceId),
        definition: { name: "docs", transport: "stdio", command: "docs-mcp" },
      }),
    );

    const first = cache.read();
    await started.promise;
    const beforeApply = fixture.events.length;
    await fixture.service.apply({ operationId: added.operation.operationId });
    expect(fixture.events.slice(beforeApply).map(([event]) => event)).toContain(
      MCP_MANAGEMENT_CHANGED_EVENT,
    );
    expect(cache.read()).toBe(first);
    pending.resolve();
    await first;
    expect(reads).toBe(1);

    const snapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(snapshot, sourceId, "docs").entryId,
        expectedRevision: revision(snapshot, sourceId)!,
        patch: { command: { kind: "set", value: "new-mcp" } },
      }),
    );
    await cache.read();
    expect(reads).toBe(2);

    fixture.write("home/.codex/config.toml", '[mcp_servers.docs]\ncommand = "external-edit"\n');
    await fixture.service.snapshot({ targetId });
    await cache.read();
    expect(reads).toBe(3);
  } finally {
    pending.resolve();
    await fixture.cleanup();
  }
});

test.each([true, false])(
  "a Codex switch invalidates after the write (confirmation succeeds: %s)",
  async (confirm) => {
    const fixture = createFixture();
    try {
      const bin = path.join(fixture.root, "bin");
      const partialContext = {
        runtimeFlavor: "agent-test" as const,
        appRoot: fixture.root,
        resourceRoot: fixture.root,
        toolchainBinDir: bin,
        storage: { getDataDir: () => fixture.dataDir },
      };
      const homes = capabilityHomes(partialContext);
      const config = path.join(homes.codexHome, "config.toml");
      await mkdir(bin, { recursive: true });
      await mkdir(homes.codexHome, { recursive: true });
      await writeFile(config, '[plugins."demo@local-test"]\nenabled = true\n');
      await writeFile(
        path.join(bin, "codex"),
        `#!/bin/sh
if /usr/bin/grep -q 'enabled = true' "$CODEX_HOME/config.toml"; then
  printf '%s\n' '{"installed":[{"pluginId":"demo@local-test","enabled":true}]}'
else
  printf '%s\n' '${confirm ? '{"installed":[{"pluginId":"demo@local-test","enabled":false}]}' : "unreadable"}'
fi
`,
        { mode: 0o700 },
      );
      let reads = 0;
      const cache = new InventoryPluginCache(async () => {
        reads += 1;
        return (await readFile(config, "utf8")).includes("enabled = true");
      });
      expect(await cache.read()).toBe(true);
      const context = {
        ...partialContext,
        capabilities: { invalidateInventory: () => cache.invalidate() },
      } as unknown as CommandContext;
      const toggle = setCapabilityPluginEnabled(context, {
        provider: "codex",
        qualifiedId: "demo@local-test",
        enabled: false,
      });
      if (confirm) {
        await expect(toggle).resolves.toMatchObject({ enabled: false, changed: true });
      } else {
        await expect(toggle).rejects.toThrow("plugin list could not be read");
      }
      expect(await cache.read()).toBe(false);
      expect(reads).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  },
);
