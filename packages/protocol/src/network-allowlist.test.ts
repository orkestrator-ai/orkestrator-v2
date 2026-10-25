import { describe, expect, test } from "bun:test";
import {
  AGENT_NETWORK_DOMAINS_BY_PLATFORM,
  DEFAULT_ALLOWED_DOMAINS,
  allowlistEntryDomain,
  allowlistForNetworkPolicy,
  imageDefaultAllowedDomains,
  parseAllowlistEntry,
} from "./network-allowlist";

describe("network allowlist entries", () => {
  test("a bare domain is TCP 443 and a port names exactly one tuple", () => {
    expect(parseAllowlistEntry("example.com")).toEqual({
      domain: "example.com",
      protocol: "tcp",
      port: 443,
    });
    expect(parseAllowlistEntry("db.example.com:5432")).toEqual({
      domain: "db.example.com",
      protocol: "tcp",
      port: 5432,
    });
    expect(parseAllowlistEntry("example.com:443/udp")).toEqual({
      domain: "example.com",
      protocol: "udp",
      port: 443,
    });
    expect(parseAllowlistEntry("example.com:22/tcp")?.protocol).toBe("tcp");
  });

  test("rejects malformed domains, ports and protocols", () => {
    for (const entry of [
      "not a domain",
      "example",
      "example.com:",
      "example.com:0",
      "example.com:0443",
      "example.com:65536",
      "example.com:443/icmp",
      "example.com/udp",
      "example.com:443:80",
    ]) {
      expect(parseAllowlistEntry(entry)).toBeNull();
    }
    expect(parseAllowlistEntry("example.com:65535")?.port).toBe(65535);
  });

  test("earlier policies receive each domain once, without ports", () => {
    expect(allowlistEntryDomain("db.example.com:5432")).toBe("db.example.com");
    expect(allowlistEntryDomain("example.com")).toBe("example.com");
    const entries = ["example.com", "example.com:80", "db.example.com:5432/udp"];
    expect(allowlistForNetworkPolicy(entries, 3)).toEqual(entries);
    expect(allowlistForNetworkPolicy(entries, 2)).toEqual(["example.com", "db.example.com"]);
    expect(allowlistForNetworkPolicy(entries, 1)).toEqual(["example.com", "db.example.com"]);
  });
});

describe("default allowlists", () => {
  test("every default and required host is a valid entry", () => {
    for (const domain of [
      ...DEFAULT_ALLOWED_DOMAINS,
      ...Object.values(AGENT_NETWORK_DOMAINS_BY_PLATFORM).flat(),
    ]) {
      expect({ domain, entry: parseAllowlistEntry(domain)?.domain }).toEqual({
        domain,
        entry: domain,
      });
    }
  });

  test("Cursor's restricted list includes the SDK's agent API host", () => {
    // `cursor.com` is an exact entry: it does not open `api.cursor.com`.
    expect(AGENT_NETWORK_DOMAINS_BY_PLATFORM.cursor).toContain("api.cursor.com");
    expect(AGENT_NETWORK_DOMAINS_BY_PLATFORM.cursor).toContain("api2.cursor.sh");
  });

  test("the image fallback is the defaults first, then each platform's hosts once", () => {
    const image = imageDefaultAllowedDomains();
    expect(image.slice(0, DEFAULT_ALLOWED_DOMAINS.length)).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
    expect(new Set(image).size).toBe(image.length);
    for (const domains of Object.values(AGENT_NETWORK_DOMAINS_BY_PLATFORM)) {
      for (const domain of domains) expect(image).toContain(domain);
    }
  });
});
