import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PREVIEW_LIMITS, previewErrorFromUnknown } from "@orkestrator/protocol/preview-services";

import { PreviewAccessService } from "./preview-access.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

describe("PreviewAccessService", () => {
  let harness: PreviewHarness;
  let clock: number;
  let issuance: boolean;
  let access: PreviewAccessService;
  let serviceId: string;
  let otherServiceId: string;

  const publication = {
    bootstrapAction: () => "https://bootstrap.preview.test/bootstrap",
    originFor: (id: string) => `https://s-${id.slice(4, 12).toLowerCase()}.preview.test`,
  };

  function publish(containerId: string, environmentId: string, hostPort: number) {
    harness.docker.containers.set(containerId, {
      id: `${containerId}-full`,
      environmentId,
      owner: harness.owner,
      ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }] },
    });
  }

  beforeEach(async () => {
    harness = await createPreviewHarness();
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    await harness.addContainerEnvironment("b", { entryPort: 3000 });
    publish("container-a", "a", 49152);
    publish("container-b", "b", 49153);
    await harness.runtime.init();
    await harness.runtime.registry.settle();
    serviceId = harness.runtime.registry.snapshot({ environmentId: "a" }).services[0]!.definition
      .serviceId;
    otherServiceId = harness.runtime.registry.snapshot({ environmentId: "b" }).services[0]!
      .definition.serviceId;
    clock = 1_000_000;
    issuance = true;
    access = new PreviewAccessService({
      registry: harness.runtime.registry,
      now: () => clock,
      issuanceEnabled: () => issuance,
      publication: () => publication,
      sweepIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    access.dispose();
    await harness.cleanup();
  });

  const category = async (promise: Promise<unknown> | (() => unknown)) => {
    try {
      await (typeof promise === "function" ? promise() : promise);
      return "ok";
    } catch (error) {
      return previewErrorFromUnknown(error)?.category ?? String(error);
    }
  };

  test("tunnel credentials authorize exactly one service and surface", async () => {
    const attachment = await access.createAttachment({
      serviceId,
      surface: "desktop-tunnel",
      clientKey: "window-1",
    });
    expect(attachment.tunnel?.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      access.authenticateTunnel(attachment.attachmentId, attachment.tunnel!.credential),
    ).toMatchObject({
      serviceId,
      surface: "desktop-tunnel",
      generation: attachment.endpointGeneration,
    });
    expect(
      await category(() => access.authenticateTunnel(attachment.attachmentId, "x".repeat(43))),
    ).toBe("forbidden");
    const other = await access.createAttachment({
      serviceId: otherServiceId,
      surface: "desktop-tunnel",
    });
    expect(
      await category(() =>
        access.authenticateTunnel(other.attachmentId, attachment.tunnel!.credential),
      ),
    ).toBe("forbidden");
    // Summaries and stats never contain secrets.
    expect(JSON.stringify([access.summaries(), access.stats()])).not.toContain(
      attachment.tunnel!.credential,
    );
  });

  test("the kill switch stops issuance without revoking active access", async () => {
    const attachment = await access.createAttachment({ serviceId, surface: "desktop-tunnel" });
    issuance = false;
    expect(await category(access.createAttachment({ serviceId, surface: "desktop-tunnel" }))).toBe(
      "unsupported",
    );
    expect(
      await category(() =>
        access.authenticateTunnel(attachment.attachmentId, attachment.tunnel!.credential),
      ),
    ).toBe("ok");
  });

  test("embedded surfaces are refused and HTTPS services are not tunnelled", async () => {
    expect(
      await category(access.createAttachment({ serviceId, surface: "browser-embedded" })),
    ).toBe("unsupported");
    await harness.runtime.registry.update(serviceId, 1, {
      scheme: "https",
      tlsServerName: "app.test",
    });
    expect(await category(access.createAttachment({ serviceId, surface: "desktop-tunnel" }))).toBe(
      "unsupported",
    );
  });

  test("a generation change revokes attachments and closes tracked resources", async () => {
    const attachment = await access.createAttachment({ serviceId, surface: "desktop-tunnel" });
    const authenticated = access.authenticateTunnel(
      attachment.attachmentId,
      attachment.tunnel!.credential,
    );
    const closed: string[] = [];
    access.track(authenticated, { close: (reason) => closed.push(reason) });
    publish("container-a2", "a", 49152);
    await harness.storage.updateEnvironment("a", { containerId: "container-a2" });
    await harness.runtime.registry.settle();
    expect(closed.length).toBe(1);
    // The holder learns to reauthorize; the stale credential can no longer connect.
    expect(
      await category(() =>
        access.authenticateTunnel(attachment.attachmentId, attachment.tunnel!.credential),
      ),
    ).toBe("access-expired");
    expect(await category(() => access.track(authenticated, { close: () => undefined }))).toBe(
      "access-expired",
    );
    // A fresh attachment binds to the new generation.
    const fresh = await access.createAttachment({ serviceId, surface: "desktop-tunnel" });
    expect(fresh.endpointGeneration).toBeGreaterThan(attachment.endpointGeneration);
  });

  test("idle expiry, bounded renewal, and absolute lifetime", async () => {
    const attachment = await access.createAttachment({ serviceId, surface: "desktop-tunnel" });
    clock += PREVIEW_LIMITS.sessionIdleMs - 1_000;
    access.renewAttachment(attachment.attachmentId);
    clock += PREVIEW_LIMITS.sessionIdleMs - 1_000;
    expect(
      await category(() =>
        access.authenticateTunnel(attachment.attachmentId, attachment.tunnel!.credential),
      ),
    ).toBe("ok");
    // Renewal can never pass the absolute lease.
    for (
      let elapsed = 0;
      elapsed < PREVIEW_LIMITS.sessionAbsoluteMs;
      elapsed += PREVIEW_LIMITS.sessionIdleMs / 2
    ) {
      clock += PREVIEW_LIMITS.sessionIdleMs / 2;
      try {
        access.renewAttachment(attachment.attachmentId);
      } catch {
        break;
      }
    }
    expect(
      await category(() =>
        access.authenticateTunnel(attachment.attachmentId, attachment.tunnel!.credential),
      ),
    ).toBe("access-expired");
  });

  test("bootstrap grants are one-use, expire, and bind to their service host", async () => {
    const attachment = await access.createAttachment({
      serviceId,
      surface: "browser-top-level",
      path: "/dashboard?x=1",
    });
    const grant = attachment.bootstrap!.grant;
    expect(attachment.bootstrap!.action).toBe("https://bootstrap.preview.test/bootstrap");
    expect(attachment.bootstrap!.origin).toBe(publication.originFor(serviceId));
    const results = await Promise.allSettled([
      Promise.resolve().then(() => access.consumeBootstrapGrant(attachment.attachmentId, grant)),
      Promise.resolve().then(() => access.consumeBootstrapGrant(attachment.attachmentId, grant)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const { code } = (
      results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{
        code: string;
      }>
    ).value;
    // The code cannot be used on another service's host, and is itself one-use.
    expect(await category(() => access.consumeSessionCode(code, otherServiceId))).toBe("forbidden");
    expect(await category(() => access.consumeSessionCode(code, serviceId))).toBe("forbidden");

    const second = await access.createAttachment({
      serviceId,
      surface: "browser-top-level",
      path: "/dashboard?x=1",
    });
    const exchanged = access.consumeBootstrapGrant(second.attachmentId, second.bootstrap!.grant);
    const session = access.consumeSessionCode(exchanged.code, serviceId);
    expect(session.path).toBe("/dashboard?x=1");
    expect(access.authenticateSession(session.session, serviceId).serviceId).toBe(serviceId);
    expect(await category(() => access.authenticateSession(session.session, otherServiceId))).toBe(
      "forbidden",
    );
    expect(
      await category(() =>
        access.authenticateTunnel(second.attachmentId, session.session.split(".")[1]!),
      ),
    ).toBe("forbidden");

    const expired = await access.createAttachment({ serviceId, surface: "browser-top-level" });
    clock += PREVIEW_LIMITS.grantTtlMs + 1;
    expect(
      await category(() =>
        access.consumeBootstrapGrant(expired.attachmentId, expired.bootstrap!.grant),
      ),
    ).toBe("access-expired");
    expect(await category(() => access.consumeBootstrapGrant("att_forged_attachment", "x"))).toBe(
      "forbidden",
    );
  });

  test("pending grants are bounded per client and service", async () => {
    for (let index = 0; index < PREVIEW_LIMITS.grantsPendingPerClientService; index += 1) {
      await access.createAttachment({ serviceId, surface: "browser-top-level", clientKey: "tab" });
    }
    expect(
      await category(
        access.createAttachment({ serviceId, surface: "browser-top-level", clientKey: "tab" }),
      ),
    ).toBe("capacity-exceeded");
    expect(
      await category(
        access.createAttachment({ serviceId, surface: "browser-top-level", clientKey: "other" }),
      ),
    ).toBe("ok");
  });

  test("attachments are bounded per service", async () => {
    for (let index = 0; index < PREVIEW_LIMITS.attachmentsPerService; index += 1) {
      await access.createAttachment({ serviceId, surface: "desktop-tunnel" });
    }
    expect(await category(access.createAttachment({ serviceId, surface: "desktop-tunnel" }))).toBe(
      "capacity-exceeded",
    );
  });

  test("revokeAll closes every resource and clears pending grants; release is idempotent", async () => {
    const attachment = await access.createAttachment({ serviceId, surface: "desktop-tunnel" });
    const authenticated = access.authenticateTunnel(
      attachment.attachmentId,
      attachment.tunnel!.credential,
    );
    const closed: string[] = [];
    access.track(authenticated, { close: (reason) => closed.push(reason) });
    await access.createAttachment({ serviceId, surface: "browser-top-level" });
    expect(access.revokeAll("credential-rotated")).toBe(2);
    expect(closed).toEqual(["credential-rotated"]);
    expect(access.stats().pendingGrants).toBe(0);
    expect(access.releaseAttachment(attachment.attachmentId)).toEqual({ released: true });
    expect(access.releaseAttachment("att_unknown_attachment")).toEqual({ released: false });
  });

  test("a stopped environment cannot be attached", async () => {
    await harness.storage.updateEnvironment("a", { status: "stopped" });
    await harness.runtime.registry.settle();
    expect(await category(access.createAttachment({ serviceId, surface: "desktop-tunnel" }))).toBe(
      "environment-stopped",
    );
  });
});
