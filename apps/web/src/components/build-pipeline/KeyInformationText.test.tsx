import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
  isBarePathToken,
  KEY_INFORMATION_CODE_CLASS,
  KeyInformationText,
  keyInformationInline,
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

describe("keyInformationInline", () => {
  test("renders bold, italic and strikethrough", () => {
    expect(keyInformationInline("**Health**: both _soft_ and *hard* ~~gone~~ now")).toEqual([
      { kind: "strong", children: [{ kind: "text", value: "Health" }] },
      { kind: "text", value: ": both " },
      { kind: "em", children: [{ kind: "text", value: "soft" }] },
      { kind: "text", value: " and " },
      { kind: "em", children: [{ kind: "text", value: "hard" }] },
      { kind: "text", value: " " },
      { kind: "strike", children: [{ kind: "text", value: "gone" }] },
      { kind: "text", value: " now" },
    ]);
  });

  test("renders __bold__ and code inside emphasis", () => {
    expect(keyInformationInline("__Docs__ and **the `backup-ts` service**")).toEqual([
      { kind: "strong", children: [{ kind: "text", value: "Docs" }] },
      { kind: "text", value: " and " },
      {
        kind: "strong",
        children: [
          { kind: "text", value: "the " },
          { kind: "code", value: "backup-ts" },
          { kind: "text", value: " service" },
        ],
      },
    ]);
  });

  test("keeps emphasis delimiters inside a code span literal", () => {
    expect(keyInformationInline("run `**x**` and `a_b_c`")).toEqual([
      { kind: "text", value: "run " },
      { kind: "code", value: "**x**" },
      { kind: "text", value: " and " },
      { kind: "code", value: "a_b_c" },
    ]);
  });

  test.each([
    ["**", "strong"],
    ["*", "em"],
    ["~~", "strike"],
  ] as const)("keeps code opaque inside %s", (marker, kind) => {
    const text = `${marker}use \`a${marker} b\` now${marker}`;
    expect(keyInformationInline(text)).toEqual([
      {
        kind,
        children: [
          { kind: "text", value: "use " },
          { kind: "code", value: `a${marker} b` },
          { kind: "text", value: " now" },
        ],
      },
    ]);
    const { container } = render(<KeyInformationText text={text} />);
    expect(container.querySelector(`${kind === "strike" ? "del" : kind} > code`)?.textContent).toBe(
      `a${marker} b`,
    );
    expect(container.textContent).toBe(`use a${marker} b now`);
  });

  test.each(["*", "_"])("resolves adjacent %s delimiter runs", (marker) => {
    for (const [text, prefix] of [
      [marker.repeat(3) + "important" + marker.repeat(3), ""],
      [marker.repeat(2) + "bold and " + marker + "important" + marker.repeat(3), "bold and "],
    ]) {
      expect(keyInformationInline(text!)).toEqual([
        {
          kind: "strong",
          children: [
            ...(prefix ? [{ kind: "text", value: prefix }] : []),
            { kind: "em", children: [{ kind: "text", value: "important" }] },
          ],
        },
      ]);
      const { container } = render(<KeyInformationText text={text!} />);
      expect(container.querySelector("strong > em")?.textContent).toBe("important");
      expect(container.textContent).toBe(prefix + "important");
    }
  });

  test.each([
    ["see __tests__/a.ts", "see ", "__tests__/a.ts"],
    ["edit __init__.py", "edit ", "__init__.py"],
  ])("preserves dunder path in %s", (text, prefix, path) => {
    expect(keyInformationInline(text)).toEqual([
      { kind: "text", value: prefix },
      { kind: "code", value: path },
    ]);
  });

  test("keeps word-leading and slash-preceded globs separate", () => {
    expect(keyInformationInline("*.test.ts and src/*.spec.ts")).toEqual([
      { kind: "code", value: "*.test.ts" },
      { kind: "text", value: " and " },
      { kind: "code", value: "src/*.spec.ts" },
    ]);
  });

  test("does not read glob stars as emphasis", () => {
    expect(keyInformationInline("globs src/**/*.ts and lib/*.js")).toEqual([
      { kind: "text", value: "globs " },
      { kind: "code", value: "src/**/*.ts" },
      { kind: "text", value: " and " },
      { kind: "code", value: "lib/*.js" },
    ]);
  });

  test("still highlights bare file paths beside emphasis", () => {
    expect(keyInformationInline("**Docs**: see docs/guides/backups.md.")).toEqual([
      { kind: "strong", children: [{ kind: "text", value: "Docs" }] },
      { kind: "text", value: ": see " },
      { kind: "code", value: "docs/guides/backups.md" },
      { kind: "text", value: "." },
    ]);
  });

  test.each([
    "2 * 3 * 4",
    "2**10 and 3**2",
    "snake_case_name and other_name",
    "a ** b ** c",
    "**unclosed bold",
    "trailing _ underscores _",
  ])("leaves %s as prose", (text) => {
    expect(keyInformationInline(text)).toEqual([{ kind: "text", value: text }]);
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

test("renders emphasis without its Markdown delimiters", () => {
  const { container } = render(
    <KeyInformationText text="**Transfers**: restic is _always_ pinned via `HTTP_PROXY`" />,
  );
  expect(container.querySelector("strong")?.textContent).toBe("Transfers");
  expect(container.querySelector("em")?.textContent).toBe("always");
  expect(container.querySelector("code")?.textContent).toBe("HTTP_PROXY");
  expect(container.textContent).toBe("Transfers: restic is always pinned via HTTP_PROXY");
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
