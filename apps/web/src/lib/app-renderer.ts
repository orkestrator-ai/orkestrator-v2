import type { ReactNode } from "react";
import type { Root, RootOptions } from "react-dom/client";

export interface RenderReactRootOptions {
  children: ReactNode;
  createRoot(
    container: Element | DocumentFragment,
    options?: RootOptions,
  ): Pick<Root, "render">;
  document: Pick<Document, "getElementById">;
  rootOptions?: RootOptions;
}

/** Create the application root and render its React tree into `#root`. */
export function renderReactRoot({
  children,
  createRoot,
  document,
  rootOptions,
}: RenderReactRootOptions): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Application root element #root was not found");
  }

  createRoot(rootElement, rootOptions).render(children);
}
