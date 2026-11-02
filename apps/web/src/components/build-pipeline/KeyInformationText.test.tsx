import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
  isBarePathToken,
  KEY_INFORMATION_CODE_CLASS,
  KeyInformationText,
  keyInformationSegments,
} from "./KeyInformationText";

describe("keyInformationSegments", () => {
  test("turns backtick spans into code", () => {
    expect(keyInformationSegments("run `npx skills` now")).toEqual([
      { kind: "text", value: "run " },
      { kind: "code", value: "npx skills" },
      { kind: "text", value: " now" },
    ]);
  });

  test.each([
    ["run (`npm test`) now", "run (", "npm test", ") now"],
    ["see (`src/a.ts`) now", "see (", "src/a.ts", ") now"],
  ])("recognizes punctuation-adjacent spans in %s", (input, before, code, after) => {
    expect(keyInformationSegments(input)).toEqual([
      { kind: "text", value: before },
      { kind: "code", value: code },
      { kind: "text", value: after },
    ]);
  });

  test("recognizes comma-adjacent spans", () => {
    expect(keyInformationSegments("run `one`,`two` now")).toEqual([
      { kind: "text", value: "run " },
      { kind: "code", value: "one" },
      { kind: "text", value: "," },
      { kind: "code", value: "two" },
      { kind: "text", value: " now" },
    ]);
  });

  test.each([":12", ":12:3", "#L12", "#L12C3"])("keeps citation %s outside the chip", (suffix) => {
    expect(keyInformationSegments(`see (apps/web/src/foo.ts${suffix}).`)).toEqual([
      { kind: "text", value: "see (" },
      { kind: "code", value: "apps/web/src/foo.ts" },
      { kind: "text", value: `${suffix}).` },
    ]);
  });

  test("highlights bare file paths and keeps surrounding punctuation as prose", () => {
    expect(
      keyInformationSegments("relays (docker/network-policy-entrypoint.sh) first; see SKILL.md."),
    ).toEqual([
      { kind: "text", value: "relays (" },
      { kind: "code", value: "docker/network-policy-entrypoint.sh" },
      { kind: "text", value: ") first; see " },
      { kind: "code", value: "SKILL.md" },
      { kind: "text", value: "." },
    ]);
  });

  test("highlights home-relative paths", () => {
    expect(keyInformationSegments("copies ~/.agents/skills, one")).toEqual([
      { kind: "text", value: "copies " },
      { kind: "code", value: "~/.agents/skills" },
      { kind: "text", value: ", one" },
    ]);
  });

  test("leaves ordinary prose alone", () => {
    expect(keyInformationSegments("and/or e.g. Node.js v1.2 at https://example.com/a.ts")).toEqual([
      { kind: "text", value: "and/or e.g. Node.js v1.2 at https://example.com/a.ts" },
    ]);
  });

  test("keeps an unmatched backtick as prose", () => {
    expect(keyInformationSegments("a ` b")).toEqual([{ kind: "text", value: "a ` b" }]);
  });
});

describe("isBarePathToken", () => {
  test.each([
    ["apps/backend/src/core/portable-inputs.ts", true],
    ["~/.claude/skills/<name>", true],
    ["/home/node", false],
    ["staged-inputs=4", false],
    ["v1.2", false],
    ["App.js", true],
    ["Index.js", true],
    ["Server.js", true],
    ["Node.js", false],
    ["Next.js", false],
    ["src/Node.js", true],
    ["example.com/a.ts", false],
    ["www.example.org/docs.md", false],
    ["src/app.ts", true],
    ["src/generated.dev/app.ts", true],
    ["./example.com/a.ts", true],
    ["apps/web/src/foo.ts:12", true],
    ["apps/web/src/foo.ts:12:3", true],
    ["apps/web/src/foo.ts#L12", true],
  ])("%s -> %p", (word, expected) => {
    expect(isBarePathToken(word)).toBe(expected);
  });
});

test("renders code segments with the transcript's inline-code chip", () => {
  const { container } = render(<KeyInformationText text="lives in apps/web/src/a.tsx" />);
  const code = container.querySelector("code");
  expect(code?.textContent).toBe("apps/web/src/a.tsx");
  expect(code?.className).toBe(KEY_INFORMATION_CODE_CLASS);
  expect(container.textContent).toBe("lives in apps/web/src/a.tsx");
});

test.each([
  ["run (`npm test`) now", ["npm test"], "run (npm test) now"],
  ["see (`src/a.ts`) now", ["src/a.ts"], "see (src/a.ts) now"],
  ["run `one`,`two` now", ["one", "two"], "run one,two now"],
  ["App.js Index.js Node.js Next.js", ["App.js", "Index.js"], "App.js Index.js Node.js Next.js"],
  [
    "see src/a.ts:12 src/b.ts:12:3 src/c.ts#L12",
    ["src/a.ts", "src/b.ts", "src/c.ts"],
    "see src/a.ts:12 src/b.ts:12:3 src/c.ts#L12",
  ],
  [
    "example.com/a.ts www.example.org/docs.md src/a.ts",
    ["src/a.ts"],
    "example.com/a.ts www.example.org/docs.md src/a.ts",
  ],
  ["keep (`unfinished", [], "keep (`unfinished"],
])("renders chips and preserves prose in %s", (text, chips, expected) => {
  const { container } = render(<KeyInformationText text={text} />);
  expect(Array.from(container.querySelectorAll("code"), (code) => code.textContent)).toEqual(chips);
  expect(container.textContent).toBe(expected);
});
