import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY,
  STATIC_HTML_FRAME_DOCUMENT,
} from "@orkestrator/protocol/renderer-content-security-policy";
import { staticHtmlFrameSource } from "../../apps/web/src/components/chat/rich/static-html-frame-source";
import { StaticHtmlFrameSession } from "../../apps/web/src/lib/chat/static-html-frame-session";
import { publicSiteDistDirectory } from "./public-site-dist";

/**
 * The hosted client's static document frame, served from the built `dist` with
 * `vercel.json`'s header rules (vercel-static-server.ts). A same-origin page
 * under the strict application policy frames the emitted document with
 * `sandbox="allow-scripts"`, as `StaticHtmlFrame` does, and the real host
 * session drives the handshake, loading the frame from the address the client's
 * own `staticHtmlFrameSource` resolves. If the frame path also received the
 * strict policy, its `script-src 'self'` would refuse the hash-pinned
 * bootstrap and the frame would never report `ready`.
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
  // Every policy the response carries, whether sent as repeated headers
  // (`headersArray()` keeps them apart; `headers()` would join them) or folded
  // into one comma-separated header, as a server may do: CSP reads a comma as
  // the boundary between policies, and neither policy here contains one.
  const policies = async (pathname: string) => {
    const response = await request.get(pathname);
    expect(response.ok(), pathname).toBe(true);
    return response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === "content-security-policy")
      .flatMap((header) => header.value.split(","))
      .map((policy) => policy.trim());
  };
  expect(await policies(framePath)).toEqual([GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY]);
  const appPolicies = await policies("/");
  expect(appPolicies).toHaveLength(1);
  const [appPolicy] = appPolicies;
  expect(appPolicy).toContain("script-src 'self'");
  expect(appPolicy).toContain("frame-ancestors 'none'");
  // Paths that only resemble the frame's, including its trailing-slash and
  // uppercase forms (different paths to Vercel's strict, case-sensitive
  // matching), get the strict policy alone.
  for (const pathname of [
    "/connect",
    "/connect/",
    `${framePath}/`,
    `${framePath}/x`,
    framePath.toUpperCase(),
    `/assets${framePath}`,
  ]) {
    expect({ pathname, policies: await policies(pathname) }).toEqual({
      pathname,
      policies: [appPolicy],
    });
  }
});

test("the built client ships the frame document and resolves frames to it", async () => {
  // The hosted build defines the frame document's name for
  // `staticHtmlFrameSource`; without it the shipped client would fall back to
  // the `srcdoc` bootstrap the strict policy refuses.
  const assets = path.join(publicSiteDistDirectory, "assets");
  const scripts = (await readdir(assets)).filter((name) => name.endsWith(".js"));
  const referencing: string[] = [];
  for (const name of scripts) {
    if ((await readFile(path.join(assets, name), "utf8")).includes(STATIC_HTML_FRAME_DOCUMENT)) {
      referencing.push(name);
    }
  }
  expect(referencing.length).toBeGreaterThan(0);
  expect(
    (await readFile(path.join(publicSiteDistDirectory, STATIC_HTML_FRAME_DOCUMENT), "utf8")).length,
  ).toBeGreaterThan(0);

  // From a nested route the client resolves the frame at the origin root, where
  // `vercel.json` gives it the sandbox rule.
  expect(
    staticHtmlFrameSource("abc", STATIC_HTML_FRAME_DOCUMENT, "https://hosted.example/connect/x"),
  ).toEqual({ src: `https://hosted.example${framePath}#abc` });
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

  const source = staticHtmlFrameSource(nonce, STATIC_HTML_FRAME_DOCUMENT, page.url());
  if (!("src" in source)) throw new Error("The hosted client resolved a srcdoc frame");
  expect(source.src).toBe(new URL(`${framePath}#${nonce}`, page.url()).href);
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
    { src: source.src },
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
