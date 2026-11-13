import { describe, expect, test } from "bun:test";
import { describeVersionReminder, versionClientKind } from "./version-reminder";

const versions = { clientVersion: "2.19.17", backendVersion: "2.20.0" };

describe("versionClientKind", () => {
  test("recognises the Electron renderer, local or remote", () => {
    expect(versionClientKind({ orkestrator: { isolatedViewState: true } as never })).toBe(
      "desktop",
    );
    expect(
      versionClientKind({
        orkestratorGateway: { enabled: true, desktop: true, baseUrl: "https://host:1" },
      }),
    ).toBe("desktop");
  });

  test("tells a hosted renderer from one the backend served", () => {
    expect(
      versionClientKind({ orkestratorGateway: { enabled: true, baseUrl: "https://host:1" } }),
    ).toBe("hosted");
    expect(versionClientKind({ orkestratorGateway: { enabled: true } })).toBe("backend-served");
    expect(versionClientKind({})).toBe("backend-served");
  });
});

describe("describeVersionReminder", () => {
  test("stays quiet when the versions match", () => {
    expect(
      describeVersionReminder({ ...versions, skew: "same", clientKind: "desktop" }),
    ).toBeNull();
  });

  test("asks a backend-served page to reload in either direction", () => {
    for (const skew of ["client-older", "backend-older"] as const) {
      const reminder = describeVersionReminder({ ...versions, skew, clientKind: "backend-served" });
      expect(reminder?.action).toBe("reload");
      expect(reminder?.description).toContain("2.20.0");
    }
  });

  test("names an older server as the side to update, not as an update", () => {
    // What today's renderer showed against v2.21.0 (to-do 7120 (retired) task 4): "has
    // been updated" and a reload, although the server was the older side.
    const reminder = describeVersionReminder({
      clientVersion: "2.36.4-beta",
      backendVersion: "2.21.0",
      skew: "backend-older",
      clientKind: "backend-served",
    });
    expect(reminder?.title).toBe("This server runs an older Orkestrator");
    expect(reminder?.description).toBe(
      "It runs Orkestrator 2.21.0, and this page is 2.36.4-beta; some features are unavailable until the server is updated. Reload to load the server's own version.",
    );
    expect(reminder?.action).toBe("reload");
  });

  test("does not offer a reload that already failed to change the versions", () => {
    const older = {
      clientVersion: "2.36.4-beta",
      backendVersion: "2.21.0",
      skew: "backend-older" as const,
      reloadTried: true,
    };
    const served = describeVersionReminder({ ...older, clientKind: "backend-served" });
    expect(served?.title).toBe("This server runs an older Orkestrator");
    expect(served?.description).not.toContain("Reload");
    expect(served?.action).toBeNull();
    expect(
      describeVersionReminder({ ...older, clientKind: "backend-served", hostCanUpdate: true })
        ?.action,
    ).toBe("update");

    const newer = describeVersionReminder({
      ...versions,
      skew: "client-older",
      clientKind: "backend-served",
      reloadTried: true,
    });
    expect(newer?.title).not.toBe("Orkestrator has been updated");
    expect(newer?.action).toBeNull();
    const hosted = describeVersionReminder({
      ...versions,
      skew: "client-older",
      clientKind: "hosted",
      reloadTried: true,
    });
    expect(hosted?.action).toBeNull();
    expect(hosted?.description).not.toContain("Reload to");
  });

  test("points an out-of-date desktop app at the updater", () => {
    const reminder = describeVersionReminder({
      ...versions,
      skew: "client-older",
      clientKind: "desktop",
    });
    expect(reminder?.title).toBe("Update Orkestrator");
    expect(reminder?.description).toContain("Check for Updates…");
    expect(reminder?.action).toBeNull();
  });

  test("asks for the backend to be updated when it is the older side", () => {
    for (const clientKind of ["desktop", "hosted"] as const) {
      const reminder = describeVersionReminder({
        clientVersion: "2.20.0",
        backendVersion: "2.19.17",
        skew: "backend-older",
        clientKind,
      });
      expect(reminder?.title).toBe("The Orkestrator backend is out of date");
      expect(reminder?.description).toContain("computer running the backend");
      expect(reminder?.description).toContain(
        "runs an older Orkestrator (2.19.17) than this app (2.20.0); some features are unavailable until it is updated.",
      );
      expect(reminder?.action).toBeNull();
    }
  });

  test("offers to update a backend whose host can update itself", () => {
    const reminder = describeVersionReminder({
      clientVersion: "2.20.0",
      backendVersion: "2.19.17",
      skew: "backend-older",
      clientKind: "desktop",
      hostCanUpdate: true,
    });
    expect(reminder?.action).toBe("update");
    expect(reminder?.description).toContain("Update it from here");
  });

  test("offers a reload to an out-of-date hosted web app", () => {
    const reminder = describeVersionReminder({
      ...versions,
      skew: "client-older",
      clientKind: "hosted",
    });
    expect(reminder?.action).toBe("reload");
  });

  test("does not claim a direction for an unorderable mismatch", () => {
    const reminder = describeVersionReminder({
      clientVersion: "dev",
      backendVersion: "2.19.17",
      skew: "different",
      clientKind: "desktop",
    });
    expect(reminder?.title).toBe("Orkestrator versions differ");
    expect(reminder?.description).toContain("Update the older one");
  });
});
