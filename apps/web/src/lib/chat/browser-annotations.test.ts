import { beforeEach, describe, expect, test } from "bun:test";
import type { BrowserPreviewElementDetails } from "@orkestrator/protocol/browser-preview";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
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
});
