import { describe, expect, test } from "bun:test";
import {
  GRAPH_PROMPT_MAX_DIAGNOSTICS,
  GRAPH_PROMPT_TEMPLATE_LIMITS,
  isGraphPromptFalsy,
  lookupGraphPromptPath,
  parseGraphPromptTemplate,
  renderGraphPromptSource,
  renderGraphPromptTemplate,
} from "./prompt-template.js";

const render = (source: string, context: unknown, partials: Record<string, string> = {}) =>
  renderGraphPromptSource(source, context, {
    allowPartials: true,
    partial: (port) => partials[port],
  });

const codes = (diagnostics: readonly { code: string }[]) => diagnostics.map((entry) => entry.code);

describe("variables", () => {
  test("dotted names, numbers, booleans, null and objects", () => {
    const context = {
      lens: { label: "Security" },
      n: 3,
      flag: false,
      none: null,
      obj: { a: "<b>" },
      list: ["x", "y"],
    };
    expect(render("{{lens.label}}|{{n}}|{{flag}}|{{none}}|{{list.1}}", context).text).toBe(
      "Security|3|false||y",
    );
    // Objects render as framed JSON: no raw `<` or `>` survives.
    expect(render("{{obj}}", context).text).toBe('{"a":"\\u003cb\\u003e"}');
  });

  test("whitespace inside a tag is ignored", () => {
    expect(render("{{  lens.label }}", { lens: { label: "L" } }).text).toBe("L");
  });

  test("escapeValue applies to values, escapeText to text", () => {
    const result = renderGraphPromptSource(
      "<{{v}}>",
      { v: "<x>" },
      {
        escapeValue: (text) => text.replaceAll("<", "&lt;"),
        escapeText: (text) => text.toUpperCase(),
      },
    );
    expect(result.text).toBe("<&lt;x>>");
  });
});

describe("value origins", () => {
  test("frameValue sees each value's path from the root, through sections and aliases", () => {
    const seen: string[] = [];
    const result = renderGraphPromptSource(
      "{{#list}}{{name}}{{#tags}}{{.}}{{/tags}}{{outer}}{{/list}}{{#obj}}{{a}}{{/obj}}{{alias.x}}{{obj.a}}",
      { list: [{ name: "n", tags: ["t"] }], outer: "o", obj: { a: "A" } },
      {
        lookup: { aliases: new Map([["alias.x", 1]]) },
        frameValue: (origin) => {
          seen.push(`${origin.alias ? "alias:" : ""}${origin.path.join(".")}`);
          return origin.path[0] === "obj" ? [["port", "obj"]] : undefined;
        },
      },
    );
    expect(seen).toEqual([
      "list.0.name",
      "list.0.tags.0",
      "outer",
      "obj.a",
      "alias:alias.x",
      "obj.a",
    ]);
    expect(result.text).toBe(
      'nto<orkestrator-evidence port="obj">A</orkestrator-evidence>1<orkestrator-evidence port="obj">A</orkestrator-evidence>',
    );
  });

  test("a name that does not resolve renders as written, unframed", () => {
    const result = renderGraphPromptSource(
      "{{missing}}",
      {},
      { frameValue: () => [["port", "x"]] },
    );
    expect(result.text).toBe("{{missing}}");
  });
});

describe("code-like templates render literally", () => {
  const cases: [string, unknown][] = [
    ["{{constructor}}", {}],
    ["{{toString}}", {}],
    ["{{hasOwnProperty}}", { a: 1 }],
    ["{{a.constructor}}", { a: {} }],
    ["{{a.__proto__}}", { a: {} }],
    ["{{list.length}}", { list: [1, 2] }],
    ["{{text.length}}", { text: "abc" }],
    ["{{constructor.name}}", {}],
    ["{{#each items}}x{{/each}}", { items: [1] }],
    ["{{{raw}}}", { raw: "<b>" }],
    ["{{&raw}}", { raw: "<b>" }],
    ["{{= <% %> =}}", {}],
    ["{{ a + b }}", { a: 1, b: 2 }],
    ["{{a()}}", { a: 1 }],
    ["{{a[0]}}", { a: [1] }],
    ["${a} and `${b}`", { a: 1 }],
    ["{{> other}}", {}],
    ["{{missing}}", {}],
    ["{{a.b.c}}", { a: { b: 1 } }],
    ["{{list.-1}}", { list: [1] }],
    ["{{list.01}}", { list: [1, 2] }],
  ];
  for (const [source, context] of cases) {
    test(source, () => {
      const result = render(source, context);
      expect(result.text).toBe(source);
      expect(result.truncated).toBe(false);
    });
  }

  test("a section over a prototype name is falsy, its inverse renders", () => {
    expect(
      render("{{#constructor}}yes{{/constructor}}{{^constructor}}no{{/constructor}}", {}).text,
    ).toBe("no");
  });

  test("an own __proto__ property (JSON input) is an ordinary field", () => {
    const value = JSON.parse('{"__proto__":{"x":"own"},"y":1}');
    expect(render("{{__proto__.x}}|{{y}}", value).text).toBe("own|1");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test("objects with a prototype other than Object are not read", () => {
    class Box {
      secret = "hidden";
    }
    expect(render("{{box.secret}}", { box: new Box() }).text).toBe("{{box.secret}}");
    expect(lookupGraphPromptPath([{ d: new Date(0) }], ["d", "getTime"]).found).toBe(false);
  });

  test("an unclosed {{ renders the rest as written", () => {
    const result = render("a {{b", { b: 1 });
    expect(result.text).toBe("a {{b");
    expect(codes(result.diagnostics)).toContain("prompt-template-unclosed-tag");
  });
});

describe("sections", () => {
  test("lists repeat with the element as context", () => {
    const context = {
      criteria: [
        { id: "ac-1", text: "One" },
        { id: "ac-2", text: "Two" },
      ],
    };
    expect(render("{{#criteria}}- {{id}}: {{text}}\n{{/criteria}}", context).text).toBe(
      "- ac-1: One\n- ac-2: Two\n",
    );
  });

  test("{{.}} is the current element; outer names resolve outwards", () => {
    expect(
      render("{{#tags}}[{{.}}:{{prefix}}]{{/tags}}", { tags: ["a", "b"], prefix: "p" }).text,
    ).toBe("[a:p][b:p]");
  });

  test("Mustache lookup: no fallback after the first segment is found", () => {
    const context = { item: { label: "inner" }, other: { label: "outer", deep: { x: 1 } } };
    expect(render("{{#item}}{{label}}/{{other.label}}{{/item}}", context).text).toBe("inner/outer");
    // `label` exists on the element, so `label.x` does not fall back outwards.
    expect(render("{{#item}}{{label.x}}{{/item}}", { ...context, label: { x: 1 } }).text).toBe(
      "{{label.x}}",
    );
  });

  test("objects and truthy scalars render once; falsy values not at all", () => {
    const context = {
      obj: { a: 1 },
      yes: true,
      text: "t",
      zero: 0,
      empty: "",
      none: null,
      list: [],
    };
    expect(
      render("{{#obj}}{{a}}{{/obj}}{{#yes}}Y{{/yes}}{{#text}}{{.}}{{/text}}", context).text,
    ).toBe("1Yt");
    for (const name of ["zero", "empty", "none", "list", "missing"]) {
      expect(render(`{{#${name}}}X{{/${name}}}{{^${name}}}N{{/${name}}}`, context).text).toBe("N");
    }
    expect(isGraphPromptFalsy(Number.NaN)).toBe(true);
  });

  test("standalone section lines leave no blank lines", () => {
    const source = "Criteria:\n{{#criteria}}\n- {{id}}\n{{/criteria}}\nEnd\n";
    expect(render(source, { criteria: [{ id: "a" }, { id: "b" }] }).text).toBe(
      "Criteria:\n- a\n- b\nEnd\n",
    );
    expect(render("  {{! a comment }}  \nText", {}).text).toBe("Text");
    // Not standalone when other content shares the line.
    expect(render("x {{#a}}y{{/a}}\n", { a: true }).text).toBe("x y\n");
  });

  test("unclosed and mismatched sections render as written", () => {
    const unclosed = render("{{#a}}x", { a: true });
    expect(unclosed.text).toBe("{{#a}}x");
    expect(codes(unclosed.diagnostics)).toContain("prompt-template-unclosed-section");
    const stray = render("x{{/a}}", {});
    expect(stray.text).toBe("x{{/a}}");
    expect(codes(stray.diagnostics)).toContain("prompt-template-unexpected-close");
    const crossed = render("{{#a}}{{#b}}x{{/a}}{{/b}}", { a: true, b: true });
    expect(codes(crossed.diagnostics)).toContain("prompt-template-unexpected-close");
  });
});

describe("partials", () => {
  test("{{> input.port}} expands through the callback", () => {
    expect(render("A {{> input.ticket}} B", {}, { ticket: "<frame>" }).text).toBe("A <frame> B");
  });

  test("unknown ports render as written", () => {
    expect(render("{{> input.nope}}", {}).text).toBe("{{> input.nope}}");
  });

  test("templates without partials refuse them", () => {
    const result = renderGraphPromptSource("{{> input.x}}", {}, { partial: () => "X" });
    expect(result.text).toBe("{{> input.x}}");
    expect(result.diagnostics[0]?.code).toBe("prompt-template-invalid-partial");
    expect(result.diagnostics[0]?.severity).toBe("error");
  });

  test("a throwing partial stops the render without throwing", () => {
    const result = renderGraphPromptSource(
      "a{{> input.x}}b",
      {},
      {
        allowPartials: true,
        partial: () => {
          throw new Error("boom");
        },
      },
    );
    expect(result.truncated).toBe(true);
    expect(codes(result.diagnostics)).toContain("prompt-output-truncated");
  });
});

describe("bounds", () => {
  test("templates over the size limit do not render", () => {
    const source = "x".repeat(GRAPH_PROMPT_TEMPLATE_LIMITS.maxBytes + 1);
    const parsed = parseGraphPromptTemplate(source);
    expect(parsed.nodes).toEqual([]);
    expect(codes(parsed.diagnostics)).toEqual(["prompt-template-too-large"]);
  });

  test("nesting deeper than the limit renders the extra tags as written", () => {
    const depth = GRAPH_PROMPT_TEMPLATE_LIMITS.maxDepth + 1;
    const source = `${"{{#a}}".repeat(depth)}x${"{{/a}}".repeat(depth)}`;
    const parsed = parseGraphPromptTemplate(source);
    expect(codes(parsed.diagnostics)).toContain("prompt-template-too-deep");
  });

  test("section and tag counts are bounded", () => {
    const sections = "{{#a}}{{/a}}".repeat(GRAPH_PROMPT_TEMPLATE_LIMITS.maxSections + 1);
    expect(codes(parseGraphPromptTemplate(sections).diagnostics)).toContain(
      "prompt-template-too-many-sections",
    );
    const tags = "{{a}}".repeat(GRAPH_PROMPT_TEMPLATE_LIMITS.maxTags + 1);
    const parsed = parseGraphPromptTemplate(tags);
    expect(codes(parsed.diagnostics)).toContain("prompt-template-too-many-tags");
    expect(renderGraphPromptTemplate(parsed, { a: 1 }).text).toBe(
      `${"1".repeat(GRAPH_PROMPT_TEMPLATE_LIMITS.maxTags)}{{a}}`,
    );
  });

  test("output and iterations are bounded", () => {
    const big = renderGraphPromptSource(
      "{{#l}}{{v}}{{/l}}",
      { l: Array(100).fill(0), v: "x".repeat(100) },
      {
        limits: { maxOutputBytes: 1000 },
      },
    );
    expect(big.truncated).toBe(true);
    expect(big.bytes).toBeLessThanOrEqual(1000);
    const loops = renderGraphPromptSource(
      "{{#l}}{{#l}}x{{/l}}{{/l}}",
      { l: Array(50).fill(1) },
      {
        limits: { maxIterations: 100 },
      },
    );
    expect(loops.truncated).toBe(true);
    expect(codes(loops.diagnostics)).toContain("prompt-output-truncated");
  });

  test("diagnostics are capped", () => {
    const parsed = parseGraphPromptTemplate("{{a b}}".repeat(200));
    expect(parsed.diagnostics.length).toBe(GRAPH_PROMPT_MAX_DIAGNOSTICS);
  });

  test("never throws on arbitrary input", () => {
    const alphabet = [
      "{{",
      "}}",
      "#",
      "^",
      "/",
      ">",
      "!",
      "{",
      "}",
      "a",
      ".",
      " ",
      "\n",
      "input.x",
      "<",
      "&",
      "=",
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 500; round++) {
      let source = "";
      const length = Math.floor(random() * 40);
      for (let index = 0; index < length; index++) {
        source += alphabet[Math.floor(random() * alphabet.length)];
      }
      const result = render(source, { a: [{ a: 1 }], x: "y" }, { x: "X" });
      expect(typeof result.text).toBe("string");
    }
    expect(parseGraphPromptTemplate(42 as unknown as string).nodes).toEqual([]);
  });
});
