import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDesignRuntime } from "./design-runtime.js";

describe("design runtime sanitizer", () => {
  let testWindow: Window;
  beforeEach(() => {
    testWindow = new Window();
    testWindow.eval(`(${installDesignRuntime.toString()})()`);
  });

  const run = (operation: unknown) =>
    (testWindow as unknown as { orkDesign: (operation: unknown) => unknown }).orkDesign(operation);

  test("removes forbidden markup recursively from template contents", () => {
    run({
      op: "render",
      html: '<template id="outer"><script>bad()</script><iframe src="data:text/html,bad"></iframe><template><frame src="bad"></frame></template><p>safe</p></template>',
    });

    const template = testWindow.document.querySelector("#outer") as unknown as HTMLTemplateElement;
    expect(template.content.querySelectorAll("script,iframe,frame")).toHaveLength(0);
    expect(template.content.querySelector("p")?.textContent).toBe("safe");
    expect(String(run({ op: "serialize" }))).not.toContain("<script");
  });

  test("removes event handlers and executable URL attributes", () => {
    run({
      op: "render",
      html: '<a id="bad" href=" javascript:alert(1)" onclick="bad()">bad</a><img id="safe" src="data:image/png;base64,AA==">',
    });

    expect(testWindow.document.querySelector("#bad")?.hasAttribute("href")).toBe(false);
    expect(testWindow.document.querySelector("#bad")?.hasAttribute("onclick")).toBe(false);
    expect(testWindow.document.querySelector("#safe")?.getAttribute("src")).toStartWith(
      "data:image/png",
    );
  });
});
