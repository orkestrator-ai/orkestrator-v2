import { describe, expect, test } from "bun:test";
import {
  decodeResourceLink,
  encodeResourceLink,
  environmentKey,
  environmentRef,
  fileKey,
  isProvisionalBackendId,
  parseBackendId,
  parseEnvironmentKey,
  parseFileRef,
  projectKey,
  projectRef,
  provisionalBackendId,
  resourceKey,
  sameEnvironment,
  type BackendId,
} from "./federation.js";

const A = "bk_alpha" as BackendId;
const B = "bk_beta" as BackendId;

describe("backend identities", () => {
  test("accepts installation IDs and rejects addresses, ports and blanks", () => {
    expect(parseBackendId("bk_abcDEF-123")).toBe("bk_abcDEF-123" as BackendId);
    for (const bad of ["", " ", "https://host", "-x", "a b", "x".repeat(201)]) {
      expect(() => parseBackendId(bad)).toThrow();
    }
  });

  test("provisional identities are recognisable and stable for an entry", () => {
    const id = provisionalBackendId("7d3c-9f/../x");
    expect(id).toBe(provisionalBackendId("7d3c-9f/../x"));
    expect(isProvisionalBackendId(id)).toBe(true);
    expect(isProvisionalBackendId(A)).toBe(false);
  });
});

describe("resource keys", () => {
  test("ID-01: identical local IDs on different backends produce different keys", () => {
    expect(environmentKey(environmentRef(A, "env-1"))).not.toBe(
      environmentKey(environmentRef(B, "env-1")),
    );
    expect(projectKey(projectRef(A, "p"))).not.toBe(projectKey(projectRef(B, "p")));
  });

  test("resource type participates in the key", () => {
    expect(resourceKey({ kind: "project", backendId: A, projectId: "x" })).not.toBe(
      resourceKey({ kind: "environment", backendId: A, environmentId: "x" }),
    );
  });

  test("structured keys cannot collide through a delimiter", () => {
    const tricky = environmentKey(environmentRef("bk_a:environment" as BackendId, "x"));
    expect(tricky).not.toBe(environmentKey(environmentRef(A, "environment:x")));
  });

  test("environment keys round-trip", () => {
    const ref = environmentRef(A, "env-7");
    expect(parseEnvironmentKey(environmentKey(ref))).toEqual(ref);
    expect(parseEnvironmentKey("garbage")).toBeNull();
    expect(parseEnvironmentKey(projectKey(projectRef(A, "p")))).toBeNull();
  });

  test("file references include workspace lineage and stay inside the workspace", () => {
    const ref = parseFileRef({
      backendId: A,
      environmentId: "e",
      workspaceGeneration: "g1",
      relativePath: "src/config.ts",
    });
    expect(fileKey(ref)).not.toBe(fileKey({ ...ref, workspaceGeneration: "g2" }));
    expect(fileKey(ref)).not.toBe(fileKey({ ...ref, backendId: B }));
    expect(() => parseFileRef({ ...ref, relativePath: "../etc/passwd" })).toThrow();
    expect(() => parseFileRef({ ...ref, relativePath: "/srv/app/config.ts" })).toThrow();
  });

  test("sameEnvironment compares owner and ID", () => {
    expect(sameEnvironment(environmentRef(A, "e"), environmentRef(A, "e"))).toBe(true);
    expect(sameEnvironment(environmentRef(A, "e"), environmentRef(B, "e"))).toBe(false);
  });
});

describe("resource links", () => {
  test("encode a backend and resource, never a route", () => {
    const link = encodeResourceLink(environmentRef(A, "env-1"));
    expect(decodeURIComponent(link)).not.toContain("http");
    expect(decodeResourceLink(link)).toEqual(environmentRef(A, "env-1"));
    expect(decodeResourceLink(encodeResourceLink(projectRef(B, "p")))).toEqual(projectRef(B, "p"));
    expect(decodeResourceLink("%7Bnot-json")).toBeNull();
    expect(decodeResourceLink(encodeURIComponent(JSON.stringify({ b: "", e: "x" })))).toBeNull();
  });
});
