import { afterEach, describe, expect, mock, test } from "bun:test";

import { get as httpGet } from "node:http";

import { PreviewExternalHandoff } from "../../../apps/desktop/electron/preview-external-handoff";

function fetch(
  url: URL | string,
): Promise<{ status: number; headers: Map<string, string>; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    httpGet(url, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: new Map(
            Object.entries(response.headers).map(([key, value]) => [key, String(value)]),
          ),
          text: async () => body,
        }),
      );
    }).on("error", reject);
  });
}

const bootstrap = {
  action: "https://bootstrap.preview.test/bootstrap",
  grant: "g".repeat(43),
  origin: "https://s-abc.preview.test",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("PreviewExternalHandoff", () => {
  const handoffs: PreviewExternalHandoff[] = [];
  afterEach(async () => {
    await Promise.all(handoffs.splice(0).map((handoff) => handoff.close()));
  });

  function create(now = Date.now) {
    const opened: string[] = [];
    const handoff = new PreviewExternalHandoff(
      mock((url: string) => {
        opened.push(url);
      }),
      now,
    );
    handoffs.push(handoff);
    return { handoff, opened };
  }

  test("opens a one-use loopback page; the grant is only in the POST form, never the URL", async () => {
    const { handoff, opened } = create();
    await handoff.open("att_12345678", bootstrap);
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!);
    expect(url.hostname).toBe("127.0.0.1");
    expect(opened[0]).not.toContain(bootstrap.grant);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action https://bootstrap.preview.test",
    );
    const html = await page.text();
    expect(html).toContain('method="POST" action="https://bootstrap.preview.test/bootstrap"');
    expect(html).toContain(`name="grant" value="${bootstrap.grant}"`);
    expect(html).toContain('name="attachment" value="att_12345678"');

    // Replaying the handoff page reveals nothing.
    const replay = await fetch(url);
    expect(replay.status).toBe(410);
    expect(await replay.text()).not.toContain(bootstrap.grant);
    expect(handoff.pendingCount()).toBe(0);
  });

  test("expired handoffs are refused", async () => {
    let clock = 1_000;
    const { handoff, opened } = create(() => clock);
    await handoff.open("att_12345678", bootstrap);
    clock += 61_000;
    expect((await fetch(opened[0]!)).status).toBe(410);
  });

  test("refuses non-HTTPS bootstrap authorities and unknown nonces", async () => {
    const { handoff, opened } = create();
    await expect(
      handoff.open("att_12345678", {
        ...bootstrap,
        action: "http://bootstrap.preview.test/bootstrap",
      }),
    ).rejects.toThrow("HTTPS");
    await handoff.open("att_12345678", bootstrap);
    const forged = new URL(opened[0]!);
    forged.pathname = `/handoff/${"x".repeat(32)}`;
    expect((await fetch(forged)).status).toBe(410);
  });
});
