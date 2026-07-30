import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderReactRoot } from "./app-renderer";

describe("renderReactRoot", () => {
  test("creates #root with the supplied options and renders the application tree", () => {
    const rootElement = document.createElement("main");
    rootElement.id = "root";
    document.body.append(rootElement);
    const children = { type: "application-tree" } as unknown as ReactNode;
    const render = mock((_children: ReactNode) => {});
    const createRoot = mock((
      _container: Element | DocumentFragment,
      _options?: Parameters<typeof renderReactRoot>[0]["rootOptions"],
    ) => ({ render }));
    const rootOptions = {
      onCaughtError: mock((_error: unknown) => {}),
    };

    renderReactRoot({
      children,
      createRoot,
      document,
      rootOptions,
    });

    expect(createRoot).toHaveBeenCalledWith(rootElement, rootOptions);
    expect(render).toHaveBeenCalledWith(children);
    rootElement.remove();
  });

  test("fails clearly when the HTML root element is missing", () => {
    const createRoot = mock(() => ({ render: mock(() => {}) }));
    const rootlessDocument = {
      getElementById: mock((_id: string) => null),
    };

    expect(() => {
      renderReactRoot({
        children: null,
        createRoot,
        document: rootlessDocument,
      });
    }).toThrow("Application root element #root was not found");
    expect(rootlessDocument.getElementById).toHaveBeenCalledWith("root");
    expect(createRoot).not.toHaveBeenCalled();
  });
});
