import { describe, expect, mock, test } from "bun:test";
import {
  DOTENV_LANGUAGE_ID,
  dotenvLanguageConfiguration,
  dotenvMonarchLanguage,
  registerDotenvLanguage,
} from "./monaco-dotenv";

function fakeMonaco() {
  const registered: { id: string }[] = [];
  const languages = {
    getLanguages: () => registered,
    register: mock((language: { id: string }) => {
      registered.push(language);
    }),
    setMonarchTokensProvider: mock((_id: string, _language: unknown) => ({ dispose() {} })),
    setLanguageConfiguration: mock((_id: string, _config: unknown) => ({ dispose() {} })),
  };
  return { languages };
}

describe("registerDotenvLanguage", () => {
  test("registers the grammar and comment configuration once", () => {
    const monaco = fakeMonaco();

    registerDotenvLanguage(monaco as never);
    registerDotenvLanguage(monaco as never);

    expect(monaco.languages.register).toHaveBeenCalledTimes(1);
    expect(monaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: DOTENV_LANGUAGE_ID, filenames: [".env"] }),
    );
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      DOTENV_LANGUAGE_ID,
      dotenvMonarchLanguage,
    );
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      DOTENV_LANGUAGE_ID,
      dotenvLanguageConfiguration,
    );
    expect(dotenvLanguageConfiguration.comments?.lineComment).toBe("#");
  });
});

// Exercise Monaco's real compiler and lexer, rather than duplicating Monarch's
// matching/state logic in a test helper. These internal JS modules ship no types.
// @ts-expect-error Monaco internal module has no declaration file
import { compile } from "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
// @ts-expect-error Monaco internal module has no declaration file
import { MonarchTokenizer } from "monaco-editor/editor/standalone/common/monarch/monarchLexer.js";

function tokenize(source: string) {
  const tokenizer = new MonarchTokenizer(
    {},
    {},
    DOTENV_LANGUAGE_ID,
    compile(DOTENV_LANGUAGE_ID, dotenvMonarchLanguage),
    { getValue: () => 10000, onDidChangeConfiguration: () => ({ dispose() {} }) },
  );
  let state = tokenizer.getInitialState();
  try {
    return source.split("\n").map((line) => {
      const result = tokenizer.tokenize(line, true, state);
      state = result.endState;
      return result.tokens.map((token: { offset: number; type: string }, index: number) => ({
        text: line.slice(token.offset, result.tokens[index + 1]?.offset ?? line.length),
        type: token.type.replace(/\.dotenv$/, ""),
      }));
    });
  } finally {
    tokenizer.dispose();
  }
}

describe("dotenv tokenization", () => {
  test.each(["FOO=bar#comment", "FOO=#comment", "FOO=bar #comment"])(
    "recognizes unquoted comments: %s",
    (source) => {
      expect(tokenize(source)[0]).toContainEqual({ text: "#comment", type: "comment" });
    },
  );

  test.each(['"', "'", "`"])("preserves hashes and escaped delimiters in %s quotes", (quote) => {
    const tokens = tokenize(`FOO=${quote}a\\${quote}#inside${quote} #outside`)[0]!;
    expect(tokens).toContainEqual({ text: `\\${quote}`, type: "string.escape" });
    expect(tokens).toContainEqual({ text: "#inside", type: "string" });
    expect(tokens).toContainEqual({ text: "#outside", type: "comment" });
  });

  test("recognizes interpolation and resets after empty and unquoted values", () => {
    const lines = tokenize('EMPTY=\nSPACE=   \nA=$HOME/${USER}\nB="${USER}"\nC=plain\nNEXT=ok');
    expect(lines[2]?.filter((token: { type: string }) => token.type === "variable")).toEqual([
      { text: "$HOME", type: "variable" },
      { text: "${USER}", type: "variable" },
    ]);
    expect(lines[3]).toContainEqual({ text: "${USER}", type: "variable" });
    for (const line of lines) expect(line[0]?.type).toBe("key");
  });

  test.each(['"', "'", "`"])("recovers unfinished %s quotes at line boundaries", (quote) => {
    for (const tail of ["", "unfinished", "trailing\\", "$HOME", "\\n"]) {
      const lines = tokenize(`BROKEN=${quote}${tail}\nNEXT=value\n# comment`);
      expect(lines[1]?.[0]).toEqual({ text: "NEXT", type: "key" });
      expect(lines[2]?.[0]).toEqual({ text: "# comment", type: "comment" });
    }
  });

  test("keeps multiline quote recovery line scoped", () => {
    // Physical newlines recover rather than retaining a quote state indefinitely.
    // Escaped newlines inside one physical line remain part of the quoted value.
    expect(tokenize('A="first\\nsecond"\nNEXT=value')[0]).toContainEqual({
      text: "\\n",
      type: "string.escape",
    });
    expect(tokenize('A="first\nSECOND=value\nLAST=value')[1]?.[0]).toEqual({
      text: "SECOND",
      type: "key",
    });
  });
});
