import { expect, test } from "bun:test";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { managedProvider, retainProvider, retireProvider } from "./provider-retirement.js";

test("retirement waits for compound users and asynchronous readers and disposes once", async () => {
  const reading = Promise.withResolvers<unknown[]>();
  let disposals = 0;
  const raw = {
    agent: "opencode",
    async messages() {
      return reading.promise;
    },
    async dispose() {
      disposals += 1;
    },
  } as unknown as BuildPipelineProvider;
  const provider = managedProvider(raw);
  expect(managedProvider(raw) === provider).toBe(true);
  const release = retainProvider(provider);
  const read = provider.messages("session");
  retireProvider(provider);
  retireProvider(provider);
  await Promise.resolve();
  expect(disposals).toBe(0);
  reading.resolve([]);
  await read;
  expect(disposals).toBe(0);
  // No method is in flight here; a compound caller still owns its next call.
  await provider.messages("session");
  release();
  release();
  await provider.dispose?.();
  expect(disposals).toBe(1);
});

test("a rejected operation releases its lease and cleanup rejection is handled", async () => {
  const reading = Promise.withResolvers<unknown[]>();
  let disposals = 0;
  const provider = managedProvider({
    async messages() {
      return reading.promise;
    },
    async dispose() {
      disposals += 1;
      throw new Error("cleanup failed");
    },
  } as unknown as BuildPipelineProvider);
  const read = provider.messages("session");
  const rejected = read.catch((error: unknown) => error);
  retireProvider(provider);
  reading.reject(new Error("read failed"));
  expect(await rejected).toEqual(new Error("read failed"));
  await provider.dispose?.();
  expect(disposals).toBe(1);
});

test("a reader acquiring a lease before queued cleanup runs keeps the instance alive", async () => {
  let disposals = 0;
  const provider = managedProvider({
    async dispose() {
      disposals += 1;
    },
  } as unknown as BuildPipelineProvider);
  retireProvider(provider);
  const release = retainProvider(provider);
  await Promise.resolve();
  expect(disposals).toBe(0);
  release();
  await provider.dispose?.();
  expect(disposals).toBe(1);
});
