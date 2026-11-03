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
