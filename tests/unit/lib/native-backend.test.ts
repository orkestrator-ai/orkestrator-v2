import { afterEach, describe, expect, mock, test } from "bun:test";

async function loadNativeBackend() {
  return import("../../../src/lib/native/backend.ts?real") as Promise<typeof import("../../../src/lib/native/backend")>;
}

afterEach(() => {
  delete window.orkestrator;
});

describe("native backend wrapper", () => {
  test("forwards command invocations to the preload bridge", async () => {
    const { invoke } = await loadNativeBackend();
    const invokeMock = mock(async () => ({ ok: true }));
    window.orkestrator = { invoke: invokeMock } as never;

    await expect(invoke("get_projects", { limit: 1 })).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("get_projects", { limit: 1 });
  });

  test("fails clearly when the preload bridge is unavailable", async () => {
    const { invoke } = await loadNativeBackend();
    await expect(invoke("get_projects")).rejects.toThrow("native backend is not available");
  });
});
