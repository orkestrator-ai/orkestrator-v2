import { expect, test } from "bun:test";
import { designFrameSource } from "./design-frame-source";

test("production design document resolves beside file index and at the gateway root from SPA routes", () => {
  for (const [page, expected] of [
    ["file:///app/web/index.html?realm=workspace", "file:///app/web/design-frame.html"],
    [
      "https://gateway.example/projects/123?tab=design",
      "https://gateway.example/design-frame.html",
    ],
    ["https://gateway.example/", "https://gateway.example/design-frame.html"],
  ] as const)
    expect(designFrameSource("design-frame.html", page)).toEqual({ src: expected });
});

test("development still gets fresh nonce-bearing srcdoc documents", () => {
  const first = designFrameSource("", "https://gateway.example/");
  if (!("srcDoc" in first)) throw new Error("Expected srcdoc");
  expect(first.srcDoc).toContain("script-src 'nonce-");
  expect(designFrameSource("", "https://gateway.example/")).not.toEqual(first);
});
