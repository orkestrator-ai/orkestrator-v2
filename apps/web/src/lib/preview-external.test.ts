import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { invoke as nativeInvoke } from "@/lib/native/backend";

import { openServiceExternally, submitPreviewBootstrap } from "./preview-external";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const target = {
  backendInstanceId: "bk_backend_0001",
  environmentId: "env",
  serviceId: "svc_service_0001",
  path: "/app?x=1",
};

describe("external preview handoff", () => {
  const originalPlatform = window.__orkestratorClientPlatform;
  afterEach(() => {
    window.__orkestratorClientPlatform = originalPlatform;
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("submits the grant as a top-level POST form in the pre-opened window", () => {
    const targetDocument = document.implementation.createHTMLDocument("handoff");
    const submit = mock(() => undefined);
    const createElement = targetDocument.createElement.bind(targetDocument);
    spyOn(targetDocument, "createElement").mockImplementation(((tag: string) => {
      const element = createElement(tag);
      if (tag === "form") (element as HTMLFormElement).submit = submit;
      return element;
    }) as typeof targetDocument.createElement);
    submitPreviewBootstrap({ document: targetDocument } as unknown as Window, {
      action: "https://bootstrap.preview.test/bootstrap",
      grant: "secret-grant",
      attachmentId: "att_12345678",
    });
    const form = targetDocument.querySelector("form")!;
    expect(form.method.toLowerCase()).toBe("post");
    expect(form.action).toBe("https://bootstrap.preview.test/bootstrap");
    expect((form.querySelector('input[name="grant"]') as HTMLInputElement).value).toBe(
      "secret-grant",
    );
    expect(submit).toHaveBeenCalled();
    expect(targetDocument.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe(
      "no-referrer",
    );
  });

  test("iOS navigates to a one-use handoff URL that Safari opens", async () => {
    window.__orkestratorClientPlatform = "iphone-wkwebview";
    invokeMock.mockImplementation(async (command: string) =>
      command === "create_preview_handoff_url"
        ? {
            url: "https://s-1.preview.test/__orkestrator_preview/session?code=one-use",
            expiresAt: "",
          }
        : undefined,
    );
    const assign = spyOn(window.location, "assign").mockImplementation(() => undefined);
    await openServiceExternally(target);
    expect(invokeMock).toHaveBeenCalledWith("create_preview_handoff_url", {
      serviceId: target.serviceId,
      path: target.path,
      clientKey: "ios-client",
    });
    expect(assign).toHaveBeenCalledWith(
      "https://s-1.preview.test/__orkestrator_preview/session?code=one-use",
    );
    assign.mockRestore();
  });
});
