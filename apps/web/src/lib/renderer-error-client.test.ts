import { describe, expect, mock, test } from "bun:test";
import {
  isRendererErrorClientId,
  type RendererErrorEntry,
} from "@orkestrator/protocol/renderer-errors";
import {
  documentNavigationType,
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
  const reload = () => "reload";

  test("is random, valid, and kept across a reload of the same tab", () => {
    const storage = memoryStorage();
    const first = rendererErrorClientId(storage, undefined, () => "navigate");
    expect(isRendererErrorClientId(first)).toBe(true);
    expect(storage.values.get(RENDERER_ERROR_CLIENT_KEY)).toBe(first);
    expect(rendererErrorClientId(storage, undefined, reload)).toBe(first);
    expect(rendererErrorClientId(memoryStorage(), undefined, reload)).not.toBe(first);
  });

  test("a tab opened from another, with a copy of its storage, takes its own id", () => {
    // window.open and "Duplicate tab" copy the opener's session storage.
    const opener = memoryStorage();
    const openerId = rendererErrorClientId(
      opener,
      () => "opener-client-id",
      () => "navigate",
    );
    for (const type of ["navigate", "back_forward", "prerender", undefined]) {
      const copy = memoryStorage(Object.fromEntries(opener.values));
      const childId = rendererErrorClientId(
        copy,
        () => "child-client-id",
        () => type,
      );
      expect(childId).toBe("child-client-id");
      expect(copy.values.get(RENDERER_ERROR_CLIENT_KEY)).toBe("child-client-id");
    }
    // The opener keeps its own across its reloads.
    expect(rendererErrorClientId(opener, () => "never-used-id", reload)).toBe(openerId);
  });

  test("a stored value that is not an id is replaced", () => {
    const storage = memoryStorage({ [RENDERER_ERROR_CLIENT_KEY]: "not an id!" });
    expect(rendererErrorClientId(storage, () => "fresh-client-id", reload)).toBe("fresh-client-id");
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

describe("how the document was loaded", () => {
  test("reads Navigation Timing's type, and nothing when the browser does not say", () => {
    const timing = (entries: unknown[]) => ({ getEntriesByType: () => entries }) as never;
    expect(documentNavigationType(timing([{ type: "reload" }]))).toBe("reload");
    expect(documentNavigationType(timing([{ type: "navigate" }]))).toBe("navigate");
    expect(documentNavigationType(timing([]))).toBeUndefined();
    expect(documentNavigationType(undefined)).toBeUndefined();
    expect(
      documentNavigationType({
        getEntriesByType: () => {
          throw new Error("unsupported");
        },
      }),
    ).toBeUndefined();
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
