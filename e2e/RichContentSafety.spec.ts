import { expect, test } from "@playwright/test";
test("real DOMPurify SVG policy blocks executable and remote resources", async ({ page }) => {
  await page.goto("/");
  const clean = await page.evaluate(async () => {
    const { sanitizeSvg } = await window.__fixtureModules!["lib/chat/svg-sanitize"]();
    return sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"><path d="M0 0L1 1" /></marker></defs><script>bad()</script><foreignObject><p>bad</p></foreignObject><image href="https://evil.invalid/x"/><a href="javascript:bad()"><text>x</text></a><style>.x{fill:url(https://evil.invalid/x)}</style><path onload="bad()" style="fill:url(https://evil.invalid/x)" marker-end="url(#arrow)" d="M0 0L2 2" /></svg>`,
    ).svg;
  });
  expect(clean).not.toMatch(/<script|foreignObject|<image|onload|https:\/\/evil|javascript:/i);
  expect(clean).toContain("url(#arrow)");
  expect(clean).toContain("<marker");
});
test("SVG budgets apply before sanitization and invalid roots fail", async ({ page }) => {
  await page.goto("/");
  const codes = await page.evaluate(async () => {
    const { sanitizeSvg } = await window.__fixtureModules!["lib/chat/svg-sanitize"]();
    const cases: Array<[string, { maxBytes: number; maxElements: number }]> = [
      ["<svg><g/><g/></svg>", { maxBytes: 100, maxElements: 2 }],
      ["<svg/>".repeat(50), { maxBytes: 10, maxElements: 100 }],
      ["<p>not svg</p>", { maxBytes: 100, maxElements: 100 }],
    ];
    return cases.map(([markup, limits]) => {
      try {
        sanitizeSvg(markup, limits);
        return "accepted";
      } catch (error) {
        return (error as { code: string }).code;
      }
    });
  });
  expect(codes).toEqual(["too_many_elements", "too_large", "invalid_svg"]);
});
