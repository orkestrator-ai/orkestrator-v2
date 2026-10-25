import { describe, expect, test } from "bun:test";
import { fixturePreviewService } from "@orkestrator/protocol/testing/preview-contract-fixtures";
import {
  emptyPreviewReadiness,
  previewError,
  type PreviewServiceSnapshot,
} from "@orkestrator/protocol/preview-services";

import { frameworkHints, PLACEHOLDER_PREVIEW_ORIGIN } from "./preview-framework-hints";
import {
  diagnoseService,
  relocationCandidates,
  serviceOwnershipLabel,
} from "./preview-service-display";

function worktree(
  endpoint: Partial<PreviewServiceSnapshot["endpoint"]>,
  definition: Partial<PreviewServiceSnapshot["definition"]> = {},
): PreviewServiceSnapshot {
  const base = fixturePreviewService({
    definition: { targetKind: "worktree", label: "app", ...definition },
  });
  return {
    ...base,
    endpoint: {
      ...base.endpoint,
      state: "unavailable",
      transportKind: null,
      hostPort: null,
      containerId: null,
      ownership: null,
      readiness: emptyPreviewReadiness(),
      ...endpoint,
    },
  };
}

describe("local discovery diagnostics", () => {
  test("another environment's server is named as such, with the re-registration hint", () => {
    const diagnosis = diagnoseService(
      worktree({ listener: "other-environment", failure: previewError("target-unverified") }),
    );
    expect(diagnosis?.title).toBe("Another environment's server is on port 3000");
    expect(diagnosis?.detail).toContain("⌘⇧-click");
    expect(diagnosis?.actions).toEqual(["retry"]);
  });

  test("a seeded service waiting for its own server offers confirmation", () => {
    const waiting = diagnoseService(
      worktree({ listener: "none", failure: previewError("target-unverified") }),
    );
    expect(waiting?.title).toBe("Waiting for this environment's server on port 3000");
    expect(waiting?.detail).toContain("every local environment shares");
    expect(waiting?.actions).toEqual(["retry", "confirm-association"]);

    const stranger = diagnoseService(
      worktree({ listener: "unattributed", failure: previewError("target-unverified") }),
    );
    expect(stranger?.detail).toContain("did not start");

    const unchecked = diagnoseService(
      worktree({ listener: "unchecked", failure: previewError("target-unverified") }),
    );
    expect(unchecked?.detail).toContain("cannot check");
    expect(unchecked?.actions).toEqual(["confirm-association"]);
  });

  test("a confirmed service is not offered confirmation again", () => {
    const diagnosis = diagnoseService(
      worktree(
        { listener: "unattributed", failure: previewError("target-unverified") },
        { userOverride: true },
      ),
    );
    expect(diagnosis?.actions).not.toContain("confirm-association");
  });

  test("route details say what a user registration will show", () => {
    expect(
      serviceOwnershipLabel({ ownership: "managed-process", listener: "this-environment" }),
    ).toBe("started in this environment");
    expect(serviceOwnershipLabel({ ownership: "user-registered", listener: "unattributed" })).toBe(
      "user-registered · any process listening on this port is shown",
    );
    expect(
      serviceOwnershipLabel({ ownership: "user-registered", listener: "other-environment" }),
    ).toBe("user-registered · another environment's process is listening");
    expect(serviceOwnershipLabel({ ownership: "owned-container" })).toBe("owned container");
    expect(serviceOwnershipLabel({ ownership: null })).toBeNull();
  });
});

describe("port increment re-registration", () => {
  const service = (
    serviceId: string,
    port: number,
    extra: Partial<PreviewServiceSnapshot["definition"]> = {},
  ) =>
    fixturePreviewService({
      definition: { serviceId, targetKind: "worktree", applicationPort: port, ...extra },
    });

  test("offers nearby services of a matching kind and scheme, nearest first", () => {
    const candidates = relocationCandidates(
      [
        service("far", 8080),
        service("near", 3000),
        service("same", 3001),
        service("https", 3002, { scheme: "https" }),
        service("container", 3000, { targetKind: "container" }),
        service("disabled", 3000, { enabled: false }),
        service("host", 2999, { targetKind: "backend-host" }),
      ],
      { targetKind: "worktree", applicationPort: 3001, scheme: "http" },
    );
    expect(candidates.map((candidate) => candidate.definition.serviceId)).toEqual([
      "near",
      "host",
      "far",
    ]);
  });

  test("container links only offer container services", () => {
    const candidates = relocationCandidates(
      [service("local", 3000), service("box", 3000, { targetKind: "container" })],
      { targetKind: "container", applicationPort: 3001 },
    );
    expect(candidates.map((candidate) => candidate.definition.serviceId)).toEqual(["box"]);
  });
});

describe("framework setup hints", () => {
  test("fill in the service's public origin when it is published", () => {
    const hints = frameworkHints({
      origin: "https://s-abc.preview.example",
      applicationPort: 5173,
    });
    const auth = hints.find((hint) => hint.id === "authjs-v5")!;
    expect(auth.snippet).toContain("AUTH_URL=https://s-abc.preview.example/api/auth");
    expect(auth.snippet).toContain("https://s-abc.preview.example/api/auth/callback/<provider>");
    expect(hints.find((hint) => hint.id === "nextauth-v4")!.snippet).toContain(
      "NEXTAUTH_URL=https://s-abc.preview.example",
    );
    expect(hints.find((hint) => hint.id === "oauth")!.snippet).toContain("http://localhost:5173/");
    // Every hint names the versions it was written against.
    for (const hint of hints) expect(hint.versions.length).toBeGreaterThan(0);
  });

  test("use a placeholder origin when the service is not published", () => {
    for (const hint of frameworkHints({ origin: null, applicationPort: 3000 })) {
      expect(hint.snippet).not.toContain("undefined");
      expect(hint.snippet).not.toContain("null");
    }
    expect(
      frameworkHints({ origin: null, applicationPort: 3000 }).find((hint) => hint.id === "oauth")!
        .snippet,
    ).toContain(PLACEHOLDER_PREVIEW_ORIGIN);
  });
});
