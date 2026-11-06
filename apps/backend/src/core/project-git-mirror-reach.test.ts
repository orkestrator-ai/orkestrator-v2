import { describe, expect, test } from "bun:test";
import {
  containerCloneEndpoint,
  restrictedContainerReachesGitRemote,
} from "./project-git-mirror.js";

describe("where a container's clone connects", () => {
  test("SSH remotes become HTTPS on the same host, as the setup script converts them", () => {
    expect(containerCloneEndpoint("git@github.com:acme/repo.git")).toEqual({
      host: "github.com",
      port: 443,
    });
    expect(containerCloneEndpoint("ssh://git@GitLab.example.com/acme/repo.git")).toEqual({
      host: "gitlab.example.com",
      port: 443,
    });
    // The script keeps an explicit SSH port, so HTTPS is tried on it.
    expect(containerCloneEndpoint("ssh://git@git.example.com:2222/acme/repo.git")).toEqual({
      host: "git.example.com",
      port: 2222,
    });
  });

  test("HTTP(S) remotes keep their own port", () => {
    expect(containerCloneEndpoint("https://user:token@git.example.com/repo.git")).toEqual({
      host: "git.example.com",
      port: 443,
    });
    expect(containerCloneEndpoint("http://git.example.com:8080/repo.git")).toEqual({
      host: "git.example.com",
      port: 8080,
    });
    expect(containerCloneEndpoint("http://git.example.com/repo.git")?.port).toBe(80);
  });

  test("anything else has no endpoint", () => {
    expect(containerCloneEndpoint("/srv/repo.git")).toBeNull();
    expect(containerCloneEndpoint("file:///srv/repo.git")).toBeNull();
    expect(containerCloneEndpoint("git@nohost")).toBeNull();
  });
});

describe("whether a restricted container reaches the remote", () => {
  test("GitHub's ranges are open without an entry", () => {
    expect(restrictedContainerReachesGitRemote("git@github.com:acme/repo.git", [], 3)).toBe(true);
    expect(restrictedContainerReachesGitRemote("https://github.com/acme/repo.git", [], 1)).toBe(
      true,
    );
  });

  test("policy 3 needs an entry for the clone's host, protocol and port", () => {
    const remote = "https://git.example.com/acme/repo.git";
    expect(restrictedContainerReachesGitRemote(remote, ["git.example.com"], 3)).toBe(true);
    expect(restrictedContainerReachesGitRemote(remote, ["GIT.example.com:443"], 3)).toBe(true);
    expect(restrictedContainerReachesGitRemote(remote, ["git.example.com:22"], 3)).toBe(false);
    expect(restrictedContainerReachesGitRemote(remote, ["git.example.com:443/udp"], 3)).toBe(false);
    // A domain opens its own addresses, not its subdomains or its parent's.
    expect(restrictedContainerReachesGitRemote(remote, ["example.com"], 3)).toBe(false);
    expect(
      restrictedContainerReachesGitRemote(
        "http://git.example.com:8080/r.git",
        ["git.example.com"],
        3,
      ),
    ).toBe(false);
    expect(
      restrictedContainerReachesGitRemote(
        "http://git.example.com:8080/r.git",
        ["git.example.com:8080"],
        3,
      ),
    ).toBe(true);
  });

  test("earlier policies open every port of an allowed host", () => {
    expect(
      restrictedContainerReachesGitRemote(
        "http://git.example.com:8080/r.git",
        ["git.example.com:22"],
        2,
      ),
    ).toBe(true);
    expect(
      restrictedContainerReachesGitRemote("https://git.example.com/r.git", ["example.com"], 2),
    ).toBe(false);
  });

  test("a remote the container could not clone is never reachable", () => {
    expect(restrictedContainerReachesGitRemote("/srv/repo.git", ["srv.example.com"], 3)).toBe(
      false,
    );
  });
});
