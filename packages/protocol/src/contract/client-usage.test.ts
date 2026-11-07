import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import {
  DOMAIN_ADAPTER_USAGE_RING_SIZE,
  DomainAdapterUsageRing,
  MAX_DOMAIN_ADAPTER_USAGE_BATCH,
  MAX_DOMAIN_ADAPTER_USAGE_COUNT,
  RECORD_DOMAIN_ADAPTER_USAGE_COMMAND,
  domainAdapterPathId,
  isDomainAdapterPathId,
  recordDomainAdapterUsageCommand,
} from "./client-usage.js";
import { decodeCommandArgs } from "./command.js";
import { DOMAIN_NAMES, type DomainName } from "./domain.js";

/** Every value an entry may hold: a domain name and two integers. */
function namesAndNumbersOnly(value: unknown): void {
  expect(Object.keys(value as object).sort()).toEqual(["count", "domain", "version"]);
  const { domain, version, count } = value as Record<string, unknown>;
  expect(DOMAIN_NAMES).toContain(domain as DomainName);
  expect(Number.isSafeInteger(version)).toBe(true);
  expect(Number.isSafeInteger(count)).toBe(true);
}

describe("DomainAdapterUsageRing", () => {
  it("counts per (domain, version) and hands out new counts once", () => {
    const ring = new DomainAdapterUsageRing();
    ring.record("node-mail", 0);
    ring.record("node-mail", 0);
    ring.record("ticket-sync", 1);
    expect(ring.hasUnsent()).toBe(true);
    const batch = ring.takeUnsent();
    expect(batch).toEqual([
      { domain: "node-mail", version: 0, count: 2 },
      { domain: "ticket-sync", version: 1, count: 1 },
    ]);
    batch.forEach(namesAndNumbersOnly);
    expect(ring.hasUnsent()).toBe(false);
    expect(ring.takeUnsent()).toEqual([]);
    ring.restore(batch);
    expect(ring.takeUnsent()).toEqual(batch);
    expect(ring.entries()).toEqual(batch);
  });

  it("is bounded in pairs, batch size and count", () => {
    const ring = new DomainAdapterUsageRing(3);
    for (const version of [0, 1, 2, 3, 4]) ring.record("node-mail", version);
    expect(ring.entries().map((entry) => entry.version)).toEqual([2, 3, 4]);

    const wide = new DomainAdapterUsageRing();
    for (const domain of DOMAIN_NAMES)
      for (const version of [0, 1, 2]) wide.record(domain, version);
    expect(wide.entries()).toHaveLength(DOMAIN_ADAPTER_USAGE_RING_SIZE);
    expect(wide.takeUnsent()).toHaveLength(MAX_DOMAIN_ADAPTER_USAGE_BATCH);

    const capped = new DomainAdapterUsageRing();
    capped.record("node-mail", 0);
    capped.restore([
      { domain: "node-mail", version: 0, count: MAX_DOMAIN_ADAPTER_USAGE_COUNT * 2 },
    ]);
    expect(capped.takeUnsent()[0]!.count).toBe(MAX_DOMAIN_ADAPTER_USAGE_COUNT);
  });

  it("ignores anything that is not a known domain and an adapter version", () => {
    const ring = new DomainAdapterUsageRing();
    ring.record("secret-project" as DomainName, 0);
    ring.record("node-mail", -1);
    ring.record("node-mail", 1.5);
    ring.record("node-mail", 1001);
    expect(ring.entries()).toEqual([]);
  });

  it("notifies after each record and survives a throwing listener", () => {
    const ring = new DomainAdapterUsageRing();
    let calls = 0;
    const stop = ring.subscribe(() => {
      calls += 1;
      throw new Error("listener");
    });
    ring.record("node-mail", 0);
    stop();
    ring.record("node-mail", 0);
    expect(calls).toBe(1);
  });
});

describe("adapter counter ids", () => {
  it("names a source, a known domain and a version", () => {
    expect(domainAdapterPathId("renderer", "node-mail", 0)).toBe(
      "domain-adapter.renderer.node-mail.v0",
    );
    expect(isDomainAdapterPathId("domain-adapter.backend.ticket-sync.v12")).toBe(true);
    for (const id of [
      "domain-adapter.renderer.unknown.v0",
      "domain-adapter.other.node-mail.v0",
      "domain-adapter.backend.node-mail.v01",
      "domain-adapter.backend.node-mail.v1001",
      "domain-adapter.backend.node-mail",
      "machine-load.older-node",
    ]) {
      expect(isDomainAdapterPathId(id)).toBe(false);
    }
  });
});

describe("record_domain_adapter_usage", () => {
  it("is a defined system command whose arguments are bounded", () => {
    expect(recordDomainAdapterUsageCommand.name).toBe(RECORD_DOMAIN_ADAPTER_USAGE_COMMAND);
    expect(recordDomainAdapterUsageCommand.domain.name).toBe("system");
    expect(recordDomainAdapterUsageCommand.access).toBe("admin");
    const ok = decodeCommandArgs(recordDomainAdapterUsageCommand, {
      entries: [{ domain: "node-mail", version: 0, count: 3, extra: "dropped" }],
    });
    expect(Result.isSuccess(ok) && ok.success).toEqual({
      entries: [{ domain: "node-mail", version: 0, count: 3 }],
    });
    for (const entries of [
      [],
      Array.from({ length: MAX_DOMAIN_ADAPTER_USAGE_BATCH + 1 }, () => ({
        domain: "node-mail",
        version: 0,
        count: 1,
      })),
      [{ domain: "Node Mail", version: 0, count: 1 }],
      [{ domain: "node-mail", version: 0, count: 0 }],
      [{ domain: "node-mail", version: 0.5, count: 1 }],
    ]) {
      expect(
        Result.isFailure(decodeCommandArgs(recordDomainAdapterUsageCommand, { entries })),
      ).toBe(true);
    }
  });
});
