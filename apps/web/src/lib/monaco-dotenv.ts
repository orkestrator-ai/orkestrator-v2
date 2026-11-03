import type { languages } from "monaco-editor";

// Monaco ships no grammar for environment files, so the backend's `dotenv`
// language id (`.env`, `.env.*`, `*.env`) would otherwise render as plain text.
export const DOTENV_LANGUAGE_ID = "dotenv";

interface MonacoLanguagesApi {
  languages: Pick<
    typeof languages,
    "getLanguages" | "register" | "setLanguageConfiguration" | "setMonarchTokensProvider"
  >;
}

const INTERPOLATION = /\$\{[^}]*\}|\$[A-Za-z_]\w*/;

// A value runs to the end of its line, so every rule in the `value` state pops
// back to `root` when its match ends the line. Without that, an unquoted value
// would leave the next line's key tokenised as a value.
function endOfLine(token: string): languages.IMonarchLanguageAction {
  return { cases: { "@eos": { token, next: "@pop" }, "@default": token } };
}

export const dotenvMonarchLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".dotenv",
  tokenizer: {
    root: [
      [/\s+/, "white"],
      [/#.*$/, "comment"],
      [/export(?=\s)/, "keyword"],
      [/[A-Za-z_][\w.-]*/, "key"],
      [
        /[=:]/,
        { cases: { "@eos": "delimiter", "@default": { token: "delimiter", next: "@value" } } },
      ],
    ],
    value: [
      [
        /"/,
        {
          cases: {
            "@eos": { token: "string.quote", next: "@pop" },
            "@default": { token: "string.quote", switchTo: "@doubleQuoted" },
          },
        },
      ],
      [
        /'/,
        {
          cases: {
            "@eos": { token: "string.quote", next: "@pop" },
            "@default": { token: "string.quote", switchTo: "@singleQuoted" },
          },
        },
      ],
      [
        /`/,
        {
          cases: {
            "@eos": { token: "string.quote", next: "@pop" },
            "@default": { token: "string.quote", switchTo: "@backQuoted" },
          },
        },
      ],
      // Unquoted hashes start comments, even without preceding whitespace.
      [/#.*$/, { token: "comment", next: "@pop" }],
      [INTERPOLATION, endOfLine("variable")],
      [/[^\s$#"'`]+|\s+|\$/, endOfLine("string")],
    ],
    // Recover at each line boundary so unfinished quotes cannot swallow later keys.
    doubleQuoted: [
      [/[^\\"$]+/, endOfLine("string")],
      [/\\./, endOfLine("string.escape")],
      [INTERPOLATION, endOfLine("variable")],
      [/\$/, endOfLine("string")],
      [/\\$/, endOfLine("string")],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],
    singleQuoted: [
      [/[^\\']+/, endOfLine("string")],
      [/\\./, endOfLine("string.escape")],
      [/\\$/, endOfLine("string")],
      [/'/, { token: "string.quote", next: "@pop" }],
    ],
    backQuoted: [
      [/[^\\`]+/, endOfLine("string")],
      [/\\./, endOfLine("string.escape")],
      [/\\$/, endOfLine("string")],
      [/`/, { token: "string.quote", next: "@pop" }],
    ],
  },
};

export const dotenvLanguageConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [["{", "}"]],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string"] },
    { open: "`", close: "`", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
  ],
};

export function registerDotenvLanguage(monaco: MonacoLanguagesApi): void {
  if (monaco.languages.getLanguages().some((language) => language.id === DOTENV_LANGUAGE_ID)) {
    return;
  }
  monaco.languages.register({
    id: DOTENV_LANGUAGE_ID,
    aliases: ["Environment Variables", "dotenv"],
    extensions: [".env"],
    filenames: [".env"],
    filenamePatterns: [".env.*"],
  });
  monaco.languages.setMonarchTokensProvider(DOTENV_LANGUAGE_ID, dotenvMonarchLanguage);
  monaco.languages.setLanguageConfiguration(DOTENV_LANGUAGE_ID, dotenvLanguageConfiguration);
}
