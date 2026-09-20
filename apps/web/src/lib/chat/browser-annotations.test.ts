import { beforeEach, describe, expect, test } from "bun:test";
import type { BrowserPreviewElementDetails } from "@orkestrator/protocol/browser-preview";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  MAX_TRANSCRIPT_ANNOTATIONS,
  MAX_TRANSCRIPT_ANNOTATION_TEXT_LENGTH,
} from "./transcript-annotations";
import { MAX_PROMPT_ATTACHMENTS } from "./workspace-attachments";
import {
  addBrowserAnnotationToOpenNativeSessions,
  formatBrowserElementAnnotation,
} from "./browser-annotations";

const element: BrowserPreviewElementDetails = {
  pageUrl: "http://localhost:3000/dashboard",
  pageTitle: "Dashboard",
  viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
  tagName: "button",
  selector: "button#save",
  cssPath: "html > body > main > button#save",
  xpath: "/html/body/main/button",
  id: "save",
  classNames: ["primary"],
  role: null,
  ariaLabel: "Save changes",
  testId: "save-button",
  text: "Save",
  outerHtml: '<button id="save" class="primary">Save</button>',
  attributes: { id: "save", class: "primary" },
  rect: {
    x: 20,
    y: 30,
    width: 100,
    height: 40,
    top: 30,
    right: 120,
    bottom: 70,
    left: 20,
  },
  styles: { color: "rgb(255, 255, 255)", "font-size": "14px" },
  hierarchy: [
    {
      tagName: "html",
      selector: "html",
      id: null,
      classNames: [],
      role: null,
      ariaLabel: null,
      testId: null,
    },
    {
      tagName: "button",
      selector: "button#save",
      id: "save",
      classNames: ["primary"],
      role: null,
      ariaLabel: "Save changes",
      testId: "save-button",
    },
  ],
};

describe("browser annotations", () => {
  beforeEach(() => {
    useNativeComposeStore.setState({ drafts: new Map() });
    usePaneLayoutStore.setState({
      activeEnvironmentId: "env-1",
      environments: new Map([
        [
          "env-1",
          {
            root: {
              kind: "leaf",
              id: "pane-1",
              tabs: [
                { id: "browser-1", type: "browser", browserData: { url: element.pageUrl } },
                {
                  id: "agent-1",
                  type: "agent-native",
                  nativeAgentData: { environmentId: "env-1" },
                },
                {
                  id: "agent-2",
                  type: "agent-native",
                  nativeAgentData: { environmentId: "env-1", platform: "codex" },
                },
              ],
              activeTabId: "browser-1",
            },
            activePaneId: "pane-1",
            containerId: "container-1",
          },
        ],
      ]),
    });
  });

  test("formats identifying DOM, style, page, and screenshot details", () => {
    const text = formatBrowserElementAnnotation(
      element,
      "/workspace/.orkestrator/annotations/save.png",
    );

    expect(text).toContain("Page: Dashboard (http://localhost:3000/dashboard)");
    expect(text).toContain("CSS path: html > body > main > button#save");
    expect(text).toContain("XPath: /html/body/main/button");
    expect(text).toContain('data-testid="save-button"');
    expect(text).toContain('"font-size": "14px"');
    expect(text).toContain("/workspace/.orkestrator/annotations/save.png");
  });

  test("budgets large details while retaining selectors, viewport, and a truncation marker", () => {
    const text = formatBrowserElementAnnotation(
      {
        ...element,
        pageUrl: `http://localhost:3000/${"p".repeat(4_000)}`,
        selector: "s".repeat(2_000),
        cssPath: "c".repeat(8_000),
        xpath: "x".repeat(8_000),
        attributes: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`data-${index}`, "a".repeat(1_000)]),
        ),
        styles: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`style-${index}`, "v".repeat(1_000)]),
        ),
        text: "t".repeat(4_000),
        outerHtml: `<div>${"markup".repeat(2_000)}</div>`,
      },
      "/workspace/save.png",
    );

    expect(text.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ANNOTATION_TEXT_LENGTH);
    expect(text).toContain("Best selector:");
    expect(text).toContain("CSS path:");
    expect(text).toContain("XPath:");
    expect(text).toContain("Viewport: 1280×720 at 2x device pixel ratio");
    expect(text).toContain("[Additional browser element details omitted");
    expect(
      text.endsWith("[Additional browser element details omitted to fit the annotation limit.]"),
    ).toBe(true);
  });

  test("adds one shared annotation and screenshot to every open native session", () => {
    const annotation = {
      id: "browser-reference",
      source: "browser" as const,
      text: formatBrowserElementAnnotation(element, "/workspace/save.png"),
      comment: "Make this clearer",
      screenshotPath: "/workspace/save.png",
    };
    const screenshot = {
      id: "screenshot-1",
      annotationId: annotation.id,
      type: "image" as const,
      path: annotation.screenshotPath,
      name: "save.png",
    };

    expect(
      addBrowserAnnotationToOpenNativeSessions({
        environmentId: "env-1",
        annotation,
        screenshot,
      }),
    ).toEqual({ sessionCount: 2, annotationSkippedCount: 0, screenshotSkippedCount: 0 });
    for (const sessionKey of ["env-env-1:agent-1", "env-env-1:agent-2"]) {
      expect(useNativeComposeStore.getState().drafts.get(sessionKey)).toMatchObject({
        annotations: [annotation],
        attachments: [screenshot],
      });
    }
  });

  test("reports full annotation and screenshot composers independently", () => {
    const fullAnnotations = Array.from({ length: MAX_TRANSCRIPT_ANNOTATIONS }, (_, index) => ({
      id: `annotation-${index}`,
      text: `reference-${index}`,
      comment: "",
    }));
    const fullAttachments = Array.from({ length: MAX_PROMPT_ATTACHMENTS }, (_, index) => ({
      id: `attachment-${index}`,
      type: "image" as const,
      path: `/workspace/${index}.png`,
      name: `${index}.png`,
    }));
    useNativeComposeStore.getState().updateDraft("env-env-1:agent-1", {
      annotations: fullAnnotations,
    });
    useNativeComposeStore.getState().updateDraft("env-env-1:agent-2", {
      attachments: fullAttachments,
    });

    expect(
      addBrowserAnnotationToOpenNativeSessions({
        environmentId: "env-1",
        annotation: {
          id: "new-reference",
          source: "browser",
          text: "Browser element annotation",
          comment: "Fix it",
        },
        screenshot: {
          id: "new-screenshot",
          annotationId: "new-reference",
          type: "image",
          path: "/workspace/new.png",
          name: "new.png",
        },
      }),
    ).toEqual({ sessionCount: 1, annotationSkippedCount: 1, screenshotSkippedCount: 1 });
  });

  test("reports when every native session has a full annotation composer", () => {
    const fullAnnotations = Array.from({ length: MAX_TRANSCRIPT_ANNOTATIONS }, (_, index) => ({
      id: `annotation-${index}`,
      text: `reference-${index}`,
      comment: "",
    }));
    for (const sessionKey of ["env-env-1:agent-1", "env-env-1:agent-2"]) {
      useNativeComposeStore.getState().updateDraft(sessionKey, { annotations: fullAnnotations });
    }

    expect(
      addBrowserAnnotationToOpenNativeSessions({
        environmentId: "env-1",
        annotation: { id: "new", text: "reference", comment: "" },
        screenshot: { id: "shot", type: "image", path: "/workspace/new.png", name: "new.png" },
      }),
    ).toEqual({ sessionCount: 0, annotationSkippedCount: 2, screenshotSkippedCount: 0 });
  });
});
