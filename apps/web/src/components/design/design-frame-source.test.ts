import { expect, test } from "bun:test";
import {
  staticHtmlFrameSource,
  staticHtmlPresentationSupported,
} from "@/components/chat/rich/static-html-frame-source";
import { designFrameSource } from "./design-frame-source";

test("production design document resolves beside file index and at the gateway root from SPA routes", () => {
  for (const [page, expected] of [
    ["file:///app/web/index.html?workspace=w1", "file:///app/web/design-frame.html"],
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

test("srcdoc does not resolve a document URL for an opaque parent page", () => {
  const source = designFrameSource("", "about:blank");
  if (!("srcDoc" in source)) throw new Error("Expected srcdoc");
  expect(source.srcDoc).toContain("script-src 'nonce-");
});

test("the static document frame loads the same way, with its nonce in the fragment", () => {
  const nonce = "n".repeat(32);
  expect(
    staticHtmlFrameSource(nonce, "static-html-frame.html", "https://gateway.example/projects/1"),
  ).toEqual({ src: `https://gateway.example/static-html-frame.html#${nonce}` });
  expect(
    staticHtmlFrameSource(nonce, "static-html-frame.html", "file:///app/web/index.html?view=a"),
  ).toEqual({ src: `file:///app/web/static-html-frame.html#${nonce}` });
  const dev = staticHtmlFrameSource(nonce, "", "https://gateway.example/");
  if (!("srcDoc" in dev)) throw new Error("Expected srcdoc");
  expect(dev.srcDoc).toContain(`script-src 'nonce-${nonce}'`);
});

test("only a build that declares it unavailable turns the static document view off", () => {
  expect(staticHtmlPresentationSupported(undefined)).toBe(true);
  expect(staticHtmlPresentationSupported("unavailable")).toBe(false);
});
