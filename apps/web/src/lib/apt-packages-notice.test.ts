import { describe, expect, test } from "bun:test";
import { aptPackagesNotice } from "./apt-packages-notice";

const none = { packages: [], refused: [], invalid: false };

describe("what launchers say about declared Debian packages (to-do 7770)", () => {
  test("nothing when none are declared or the machine cannot tell", () => {
    expect(aptPackagesNotice(null, "restricted")).toBeNull();
    expect(aptPackagesNotice(undefined, "full")).toBeNull();
    expect(aptPackagesNotice(none, "restricted")).toBeNull();
  });

  test("names the packages, and under Restricted that the archive becomes reachable", () => {
    const declared = { ...none, packages: ["libvips-dev", "ffmpeg"] };
    expect(aptPackagesNotice(declared, "restricted")).toEqual({
      tone: "info",
      text: "Setup installs 2 Debian packages from Debian's archive (libvips-dev, ffmpeg), so this environment can also reach deb.debian.org.",
    });
    expect(aptPackagesNotice(declared, "full")?.text).toBe(
      "Setup installs 2 Debian packages from Debian's archive (libvips-dev, ffmpeg).",
    );
    expect(aptPackagesNotice({ ...none, packages: ["hello"] }, "full")?.text).toContain(
      "Setup installs a Debian package from Debian's archive (hello)",
    );
    const many = Array.from({ length: 9 }, (_, index) => `pkg${index}`);
    expect(aptPackagesNotice({ ...none, packages: many }, "full")?.text).toContain(
      "(pkg0, pkg1, pkg2, pkg3, pkg4, pkg5 and 3 more)",
    );
  });

  test("warns that setup will stop on a list the installer refuses", () => {
    expect(
      aptPackagesNotice(
        {
          packages: ["ffmpeg"],
          refused: [
            { name: "sudo", reason: "denied" },
            { name: "Bad", reason: "malformed" },
          ],
          invalid: false,
        },
        "restricted",
      ),
    ).toEqual({
      tone: "warning",
      text: "orkestrator-ai.json's aptPackages will be refused: sudo could change the container's protections; Bad is not a Debian package name. Setup will stop there.",
    });
    expect(aptPackagesNotice({ ...none, invalid: true }, "full")).toEqual({
      tone: "warning",
      text: "orkestrator-ai.json's aptPackages must be a list of at most 32 Debian package names. Setup will stop there.",
    });
  });
});
