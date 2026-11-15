import { expect, test } from "@playwright/test";
import {
  GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY,
  STATIC_HTML_FRAME_DOCUMENT,
} from "@orkestrator/protocol/renderer-content-security-policy";
import { StaticHtmlFrameSession } from "../../apps/web/src/lib/chat/static-html-frame-session";

/**
 * The hosted client's static document frame, served from the built `dist` with
 * `vercel.json`'s header rules (vercel-static-server.ts). A same-origin page
 * under the strict application policy frames the emitted document with
 * `sandbox="allow-scripts"`, as `StaticHtmlFrame` does, and the real host
 * session drives the handshake. If the frame path also received the strict
 * policy, its `script-src 'self'` would refuse the hash-pinned bootstrap and
 * the frame would never report `ready`.
 *
 * Only a real deployment proves Vercel applies the rules this way (7568, 4650
 * task 1); this proves the built document and the rules work together.
 */

const framePath = `/${STATIC_HTML_FRAME_DOCUMENT}`;

const report = `<main>
<h1>Weekly test report</h1>
<p>Rendered in the hosted client's static document frame.</p>
<table><tbody><tr><td>Unit</td><td>412</td></tr></tbody></table>
</main>`;

test("each path receives exactly one policy, the frame path the sandbox one", async ({
  request,
}) => {
  const policy = async (pathname: string) => {
    const response = await request.get(pathname);
    expect(response.ok()).toBe(true);
    return response.headers()["content-security-policy"];
  };
  // Playwright joins repeated headers with a newline, so equality also proves
  // a single policy was sent.
  expect(await policy(framePath)).toBe(GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY);
  const appPolicy = await policy("/");
  expect(appPolicy).toContain("script-src 'self'");
  expect(appPolicy).toContain("frame-ancestors 'none'");
  expect(appPolicy).not.toContain("\n");
  for (const pathname of ["/connect", `${framePath}/x`, `/assets${framePath}`]) {
    expect(await policy(pathname)).toBe(appPolicy);
  }
});

test("a page under the strict policy renders a report in the frame and its text is selectable", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) {
      violations.push(message.text().slice(0, 300));
    }
  });

  const landing = await page.goto("/");
  expect(landing?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

  const nonce = crypto.randomUUID().replaceAll("-", "");
  const session = new StaticHtmlFrameSession({
    nonce,
    generation: crypto.randomUUID().replaceAll("-", ""),
  });
  // The page forwards only messages whose source is the frame's window, so the
  // session's sender check compares this one token with itself.
  const frameWindow = {};
  const outcomes: string[] = [];
  let renderedHeight = 0;
  await page.exposeBinding("__staticHtmlFrameMessage", (_source, data: unknown) => {
    const outcome = session.handle({ source: frameWindow, data }, frameWindow);
    outcomes.push(outcome.kind);
    if (outcome.kind === "rendered") renderedHeight = outcome.height;
    if (outcome.kind !== "ready") return null;
    return session.renderMessage(
      report,
      { appearance: "light", reducedMotion: false, tokens: {} },
      "light",
    );
  });

  await page.evaluate(
    ({ src }) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("title", "Static document");
      frame.style.cssText = "position:fixed;inset:0 auto auto 0;width:600px;height:400px";
      const relay = (window as unknown as Record<string, (data: unknown) => Promise<unknown>>)
        .__staticHtmlFrameMessage!;
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        void relay(event.data).then((reply) => {
          if (reply) frame.contentWindow?.postMessage(reply, "*");
        });
      });
      frame.src = src;
      document.body.append(frame);
    },
    { src: `${framePath}#${nonce}` },
  );

  await expect.poll(() => outcomes.includes("rendered"), { timeout: 15_000 }).toBe(true);
  expect(outcomes[0]).toBe("ready");
  expect(outcomes).not.toContain("error");
  expect(renderedHeight).toBeGreaterThan(0);

  const frame = page.frameLocator('iframe[title="Static document"]');
  await expect(frame.getByRole("heading", { name: "Weekly test report" })).toBeVisible();
  await frame.getByText("Rendered in the hosted client").click({ clickCount: 3 });
  const documentFrame = page.frames().find((candidate) => candidate.url().includes(framePath));
  expect(documentFrame).toBeDefined();
  expect((await documentFrame!.evaluate(() => getSelection()?.toString() ?? "")).trim()).toContain(
    "Rendered in the hosted client's static document frame.",
  );
  expect(violations).toEqual([]);
});
