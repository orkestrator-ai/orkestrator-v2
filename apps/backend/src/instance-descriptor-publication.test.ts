import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ControlMcpServer } from "./core/control-mcp-server.js";
import { deferred } from "./core/recurring-test-support.js";
import { instanceDescriptorPath, publishInstanceDescriptor } from "./instance-descriptor.js";
import { createInstanceDescriptorPublication } from "./instance-descriptor-publication.js";

test.each([false, true])(
  "Control MCP events serialize descriptor writes across an in-flight publication; shutdown=%s",
  async (shutdown) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-instance-publication-"));
    const mcp = new ControlMcpServer(
      dataDir,
      async () => {
        throw new Error("unused");
      },
      { port: 0 },
    );
    const entered = deferred<void>();
    const release = deferred<void>();
    const failures: unknown[] = [];
    let writes = 0;
    let ready = false;
    const publication = createInstanceDescriptorPublication({
      subscribe: (listener) => mcp.onStateChange(listener),
      snapshot: () =>
        ready
          ? {
              installationId: "bk_test",
              generation: "generation-1",
              pid: process.pid,
              startedAt: new Date().toISOString(),
              url: "http://127.0.0.1:40001/",
              authFile: path.join(dataDir, "gateway-auth.json"),
              dataDir,
              appVersion: "9.9.9",
              publicApiSchemaVersion: 1,
              controlMcp: mcp.getEndpointState()!,
            }
          : null,
      publish: async (snapshot) => {
        writes++;
        if (writes === 1) {
          entered.resolve();
          await release.promise;
        }
        return publishInstanceDescriptor(snapshot);
      },
      onError: (error) => failures.push(error),
    });
    try {
      // An event before identity readiness cannot publish an incomplete descriptor.
      await publication.refresh();
      expect(writes).toBe(0);
      ready = true;
      const initial = publication.refresh();
      await entered.promise;
      // The real server's event queues a second snapshot behind the blocked write.
      await mcp.start();
      expect(writes).toBe(1);
      if (shutdown) {
        const closing = publication.close();
        await mcp.stop();
        release.resolve();
        await initial;
        await closing;
        await publication.refresh();
        expect(writes).toBe(1);
        expect(
          await readFile(instanceDescriptorPath(dataDir), "utf8").catch(() => null),
        ).toBeNull();
      } else {
        // A burst while the first write is blocked stays bounded to one pending snapshot.
        await mcp.stop();
        await mcp.start();
        expect(writes).toBe(1);
        release.resolve();
        await initial;
        // A queue barrier ensures the event-driven write has finished.
        await publication.refresh();
        const descriptor = JSON.parse(await readFile(instanceDescriptorPath(dataDir), "utf8"));
        expect(writes).toBe(2);
        expect(descriptor.controlMcp).toEqual(mcp.getEndpointState());
        expect(descriptor.controlMcp.running).toBe(true);
        expect(publication.published).toBe(true);
      }
      expect(failures).toEqual([]);
    } finally {
      release.resolve();
      await publication.close();
      await mcp.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
