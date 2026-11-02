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
