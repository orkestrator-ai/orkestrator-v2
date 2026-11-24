import { afterEach, describe, expect, test } from "bun:test";
import { downloadLinearFile } from "./download.js";

const KEY = "lin_api_secret";
const URL_ = "https://uploads.linear.app/ws/aaaa/bbbb";
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; authorization: string | undefined }> = [];

function serve(answer: (url: string) => Response | Promise<Response>): void {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
    });
    return answer(url);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("downloadLinearFile", () => {
  test("sends the key and reads the file's name and type", async () => {
    serve(
      () =>
        new Response("zip", {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="plain.zip"; filename*=UTF-8''p%C3%A4ck.zip`,
          },
        }),
    );
    const file = await downloadLinearFile(KEY, `${URL_}?signature=old`, { maxBytes: 100 });
    expect(file.contents.toString()).toBe("zip");
    expect(file).toMatchObject({ contentType: "application/zip", filename: "päck.zip" });
    expect(calls).toEqual([{ url: URL_, authorization: KEY }]);
  });

  test("follows a redirect to storage without the key", async () => {
    serve((url) =>
      url === URL_
        ? Response.redirect("https://storage.example.test/object?sig=1", 302)
        : new Response("bytes"),
    );
    const file = await downloadLinearFile(KEY, URL_, { maxBytes: 100 });
    expect(file.contents.toString()).toBe("bytes");
    expect(calls[1]).toEqual({
      url: "https://storage.example.test/object?sig=1",
      authorization: undefined,
    });
  });

  test("refuses a plain-HTTP redirect, an endless one and other hosts", async () => {
    serve(() => Response.redirect("http://storage.example.test/x", 302));
    await expect(downloadLinearFile(KEY, URL_, { maxBytes: 1 })).rejects.toThrow(
      "unusable address",
    );
    serve(() => Response.redirect(URL_, 302));
    await expect(downloadLinearFile(KEY, URL_, { maxBytes: 1 })).rejects.toThrow("too many times");
    serve(() => new Response("x"));
    await expect(downloadLinearFile(KEY, "https://evil.test/a", { maxBytes: 1 })).rejects.toThrow(
      "Not a file",
    );
    expect(calls).toEqual([]);
  });

  test("stops at the size limit, declared or not", async () => {
    serve(() => new Response("x", { headers: { "content-length": "101" } }));
    await expect(downloadLinearFile(KEY, URL_, { maxBytes: 100 })).rejects.toThrow("larger than");
    serve(
      () =>
        new Response(
          new ReadableStream({
            pull: (controller) => controller.enqueue(new Uint8Array(64)),
          }),
        ),
    );
    await expect(downloadLinearFile(KEY, URL_, { maxBytes: 100 })).rejects.toThrow("larger than");
  });

  test("explains a refusal, and names neither key nor address on a failure", async () => {
    serve(() => new Response("no", { status: 401 }));
    await expect(downloadLinearFile(KEY, URL_, { maxBytes: 1 })).rejects.toThrow(
      "refused the download (401)",
    );
    serve(() => {
      throw new Error(`connect ${URL_} ${KEY}`);
    });
    await expect(downloadLinearFile(KEY, URL_, { maxBytes: 1 })).rejects.toThrow(
      /^Linear's file host is unreachable\.$/,
    );
  });
});
