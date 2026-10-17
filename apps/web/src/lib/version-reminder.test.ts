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
