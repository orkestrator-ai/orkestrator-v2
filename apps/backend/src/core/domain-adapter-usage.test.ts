/**
 * Domain client adapter usage on the backend (plan item 1009): the
 * renderer upload command, the backend recorder and the compatibility-path
 * ids, plus the legacy capability commands against the contract domain map.
 */
import { describe, expect, test } from "bun:test";
import { LEGACY_CAPABILITY_COMMANDS } from "@orkestrator/protocol/contract/client";
import {
  RECORD_DOMAIN_ADAPTER_USAGE_COMMAND,
  recordDomainAdapterUsageCommand,
} from "@orkestrator/protocol/contract/client-usage";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { CommandRegistry, createRegistryRegistrar } from "./commands-registry-contracts.js";
import { registerSystemCommands } from "./commands-registry-system.js";
import {
  CompatibilityPathUsage,
  compatibilityPathUsage,
  normalizeCompatibilityPathUsage,
} from "./compatibility-path-usage.js";
import { contractDomainsByCommand } from "./contract-domain-map.js";
import {
  backendDomainAdapterUsage,
  recordRendererDomainAdapterUsage,
} from "./domain-adapter-usage.js";
import { grantAdmits } from "./nodes/workspace-grant-test-support.js";

const at = () => new Date("2026-11-07T10:00:00.000Z");

describe("recordRendererDomainAdapterUsage", () => {
  test("counts listed adapters below the current version and drops the rest", () => {
    const usage = new CompatibilityPathUsage(at);
    const result = recordRendererDomainAdapterUsage(
      [
        { domain: "node-mail", version: 0, count: 3 },
        { domain: "node-mail", version: 2, count: 1 },
        { domain: "unknown-domain", version: 0, count: 1 },
        { domain: "ticket-sync", version: 1, count: 2_000_000 },
      ],
      { counted: new Set(["node-mail@0", "ticket-sync@1"]), usage },
    );
    expect(result).toEqual({ accepted: 2, dropped: 2 });
    const snapshot = usage.snapshot();
    expect(snapshot.paths).toEqual({
      "domain-adapter.renderer.node-mail.v0": {
        count: 3,
        firstSeenAt: at().toISOString(),
        lastSeenAt: at().toISOString(),
      },
      "domain-adapter.renderer.ticket-sync.v1": {
        count: 1_000_000,
        firstSeenAt: at().toISOString(),
        lastSeenAt: at().toISOString(),
      },
    });
    // Names and numbers only: nothing but the id, a count and two times.
    for (const [id, entry] of Object.entries(snapshot.paths)) {
      expect(id).toMatch(/^domain-adapter\.renderer\.[a-z-]+\.v\d+$/u);
      expect(Object.keys(entry!).sort()).toEqual(["count", "firstSeenAt", "lastSeenAt"]);
    }
  });

  // The pilot domains (plan item 1010) are the first listed clients.
  test("counts the listed legacy adapters and drops the current version and unlisted pairs", () => {
    const usage = new CompatibilityPathUsage(at);
    expect(
      recordRendererDomainAdapterUsage(
        [
          { domain: "node-mail", version: 0, count: 1 },
          { domain: "node-mail", version: 1, count: 1 },
          // Every domain has a client since 7006-7009: a version no adapter
          // list holds is the unlisted pair.
          { domain: "git", version: 7, count: 1 },
        ],
        { usage },
      ),
    ).toEqual({ accepted: 1, dropped: 2 });
    expect(Object.keys(usage.snapshot().paths)).toEqual(["domain-adapter.renderer.node-mail.v0"]);
  });
});

describe("backend adapter usage", () => {
  test("records the backend's own adapter calls as compatibility paths", () => {
    const id = "domain-adapter.backend.node-mail.v0";
    const before = compatibilityPathUsage.peek().paths[id]?.count ?? 0;
    backendDomainAdapterUsage("node-mail", 0);
    backendDomainAdapterUsage("node-mail", 0);
    expect(compatibilityPathUsage.peek().paths[id]?.count).toBe(before + 2);
  });

  test("record takes a count and ignores one that is not a positive integer", () => {
    const usage = new CompatibilityPathUsage(at);
    usage.record("domain-adapter.backend.nodes.v1", 4);
    usage.record("domain-adapter.backend.nodes.v1", 0);
    usage.record("domain-adapter.backend.nodes.v1", 1.5);
    usage.record("domain-adapter.backend.nodes.v1");
    expect(usage.snapshot().paths["domain-adapter.backend.nodes.v1"]?.count).toBe(5);
  });

  test("snapshots keep well-formed adapter ids and drop malformed ones", () => {
    const entry = { count: 1, firstSeenAt: at().toISOString(), lastSeenAt: at().toISOString() };
    const normalized = normalizeCompatibilityPathUsage({
      version: 1,
      paths: {
        "domain-adapter.renderer.node-mail.v0": entry,
        "domain-adapter.renderer.made-up.v0": entry,
        "domain-adapter.anyone.node-mail.v0": entry,
        "machine-load.older-node": entry,
      },
    });
    expect(Object.keys(normalized.paths).sort()).toEqual([
      "domain-adapter.renderer.node-mail.v0",
      "machine-load.older-node",
    ]);
  });
});

describe("the record_domain_adapter_usage command", () => {
  function command(): CommandHandler {
    const commands = new CommandRegistry();
    registerSystemCommands(createRegistryRegistrar(commands, { validateResults: true }));
    expect(commands.contracts.get(RECORD_DOMAIN_ADAPTER_USAGE_COMMAND)).toBe(
      recordDomainAdapterUsageCommand as never,
    );
    expect(commands.helloDomains()).toEqual({ system: { min: 1, max: 1 } });
    return commands.get(RECORD_DOMAIN_ADAPTER_USAGE_COMMAND)!;
  }

  test("is registered with its definition and answers what it counted", async () => {
    const handler = command();
    expect(
      await handler(
        { entries: [{ domain: "node-mail", version: 1, count: 2 }] },
        {} as CommandContext,
      ),
    ).toEqual({ accepted: 0, dropped: 1 });
    expect(() => handler({ entries: [] }, {} as CommandContext)).toThrow();
    expect(() =>
      handler({ entries: [{ domain: "node-mail", version: -1, count: 1 }] }, {} as CommandContext),
    ).toThrow();
  });

  test("is refused to workspace clients", () => {
    expect(grantAdmits(RECORD_DOMAIN_ADAPTER_USAGE_COMMAND)).toBe(false);
  });
});

test("each legacy capability command belongs to the domain that lists it", () => {
  // A string command's domain is in the map; a converted one's is its definition's.
  const domains = contractDomainsByCommand();
  const defined = createCommandRegistry().contracts;
  for (const [domain, commands] of Object.entries(LEGACY_CAPABILITY_COMMANDS)) {
    for (const command of commands ?? [])
      expect(domains.get(command) ?? defined.get(command)?.domain.name).toBe(domain as never);
  }
});
