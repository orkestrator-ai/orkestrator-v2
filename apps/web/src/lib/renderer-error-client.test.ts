import { describe, expect, mock, test } from "bun:test";
import {
  isRendererErrorClientId,
  type RendererErrorEntry,
} from "@orkestrator/protocol/renderer-errors";
import {
  RENDERER_ERROR_CLIENT_KEY,
  rendererErrorClientId,
  rendererErrorSender,
} from "./renderer-error-client";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const entry: RendererErrorEntry = {
  errorClass: "Error",
  boundary: "window",
  route: "browser",
  fingerprint: "deadbeef",
  count: 2,
};

describe("the renderer's upload id", () => {
  test("is random, valid, and kept across a reload of the same tab", () => {
    const storage = memoryStorage();
    const first = rendererErrorClientId(storage);
    expect(isRendererErrorClientId(first)).toBe(true);
    expect(storage.values.get(RENDERER_ERROR_CLIENT_KEY)).toBe(first);
    expect(rendererErrorClientId(storage)).toBe(first);
    expect(rendererErrorClientId(memoryStorage())).not.toBe(first);
  });

  test("a stored value that is not an id is replaced", () => {
    const storage = memoryStorage({ [RENDERER_ERROR_CLIENT_KEY]: "not an id!" });
    expect(rendererErrorClientId(storage, () => "fresh-client-id")).toBe("fresh-client-id");
    expect(storage.values.get(RENDERER_ERROR_CLIENT_KEY)).toBe("fresh-client-id");
  });

  test("blocked storage still gives an id for this load", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(isRendererErrorClientId(rendererErrorClientId(blocked))).toBe(true);
    expect(isRendererErrorClientId(rendererErrorClientId(null))).toBe(true);
  });
});

describe("the send", () => {
  test("names the client", async () => {
    const invoke = mock(async () => ({ accepted: 1, dropped: 0 }));
    await rendererErrorSender(invoke, "client-0001")([entry]);
    expect(invoke).toHaveBeenCalledWith({ entries: [entry], client: "client-0001" });
  });

  test("a backend that refuses the argument gets the batch again without it, from then on", async () => {
    const calls: unknown[] = [];
    const invoke = mock(async (args: unknown) => {
      calls.push(args);
      if ((args as { client?: string }).client) {
        throw new Error("Unexpected arguments field: client");
      }
      return { accepted: 1, dropped: 0 };
    });
    const send = rendererErrorSender(invoke, "client-0001");
    expect(await send([entry])).toEqual({ accepted: 1, dropped: 0 });
    await send([entry]);
    expect(calls).toEqual([
      { entries: [entry], client: "client-0001" },
      { entries: [entry] },
      { entries: [entry] },
    ]);
  });

  test("any other failure reaches the uploader unchanged", async () => {
    const failure = new Error("backend unreachable");
    const invoke = mock(async () => {
      throw failure;
    });
    const send = rendererErrorSender(invoke, "client-0001");
    await expect(send([entry])).rejects.toBe(failure);
    await expect(send([entry])).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
