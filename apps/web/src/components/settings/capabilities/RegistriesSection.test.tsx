import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { CapabilityRegistryList } from "@orkestrator/protocol/capability-registry";

import { capabilitiesApi } from "@/lib/backend/capabilities";

import { ManifestSignatureNote } from "./ManifestSignatureNote";
import { RegistriesSection } from "./RegistriesSection";
import { RegistrySourcePicker } from "./RegistrySourcePicker";

const list: CapabilityRegistryList = {
  revision: 4,
  registries: [
    {
      id: "team",
      label: "Team registry",
      indexUrl: "https://registry.example.com/index.json",
      signingKeyId: "0123456789abcdef0123456789abcdef",
      addedAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
      packageCount: 3,
    },
  ],
  requireSignedManifests: false,
  signingKey: { keyId: "ab".repeat(16), fingerprint: "abab abab abab abab abab abab abab abab" },
};

afterEach(() => {
  cleanup();
  mock.restore();
});

test("lists registries, adds one and turns on the signed-manifest policy", async () => {
  spyOn(capabilitiesApi, "listCapabilityRegistries").mockResolvedValue(list);
  const save = spyOn(capabilitiesApi, "saveCapabilityRegistry").mockResolvedValue(list);
  const policy = spyOn(capabilitiesApi, "setCapabilityManifestPolicy").mockResolvedValue({
    ...list,
    requireSignedManifests: true,
  });
  render(<RegistriesSection />);
  expect(await screen.findByText("Team registry")).toBeTruthy();
  expect(screen.getByText("3 package(s)")).toBeTruthy();
  expect(screen.getByText("Signed index required")).toBeTruthy();
  expect(screen.getByText(/signs with key abab abab/)).toBeTruthy();

  const add = screen.getByRole("button", { name: /Add registry/ });
  expect((add as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Id"), { target: { value: "docs" } });
  fireEvent.change(screen.getByLabelText("Index address"), {
    target: { value: "https://docs.example.com/index.json" },
  });
  fireEvent.click(add);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]?.[0]).toEqual({
    id: "docs",
    indexUrl: "https://docs.example.com/index.json",
  });

  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() => expect(policy).toHaveBeenCalledWith(true));
});

test("the registry source browses the index and picks a package", async () => {
  spyOn(capabilitiesApi, "listCapabilityRegistries").mockResolvedValue(list);
  const browse = spyOn(capabilitiesApi, "listCapabilityRegistryPackages").mockResolvedValue({
    registryId: "team",
    packages: [
      {
        qualifiedId: "team/review",
        displayName: "Review",
        description: "Reviews changes",
        latest: "1.2.0",
        versions: ["1.2.0", "1.1.0"],
      },
    ],
    truncated: 0,
  });
  const onChange = mock(() => undefined);
  render(<RegistrySourcePicker value={null} onChange={onChange} />);
  fireEvent.change(await screen.findByLabelText("Package"), { target: { value: "rev" } });
  fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
  await waitFor(() => expect(browse).toHaveBeenCalledWith("team", "rev"));
  fireEvent.click(await screen.findByRole("radio"));
  expect(onChange).toHaveBeenLastCalledWith({ registryId: "team", qualifiedId: "team/review" });
  expect(screen.getByText("1.2.0")).toBeTruthy();
});

test("with no registry the source says where to add one", async () => {
  spyOn(capabilitiesApi, "listCapabilityRegistries").mockResolvedValue({
    ...list,
    registries: [],
  });
  render(<RegistrySourcePicker value={null} onChange={() => undefined} />);
  expect((await screen.findByTestId("registry-source-empty")).textContent).toContain(
    "Setups → Registries",
  );
});

test("the import signature line names the signer, the policy and an invalid signature", () => {
  const { rerender } = render(
    <ManifestSignatureNote
      signature={{ status: "trusted", label: "Alice", fingerprint: "ab12 cd34" }}
      required={false}
      onTrusted={() => undefined}
    />,
  );
  expect(screen.getByTestId("manifest-signature").textContent).toContain(
    "Signed by Alice (key ab12 cd34).",
  );
  rerender(
    <ManifestSignatureNote
      signature={{ status: "untrusted", fingerprint: "ab12", publicKey: "A".repeat(43) }}
      required
      onTrusted={() => undefined}
    />,
  );
  expect(screen.getByTestId("manifest-signature").textContent).toContain(
    "Your policy requires a trusted signature.",
  );
  expect(screen.getByRole("button", { name: "Trust key" })).toBeTruthy();
  rerender(
    <ManifestSignatureNote
      signature={{ status: "invalid", reason: "The lockfile was changed after it was signed." }}
      required={false}
      onTrusted={() => undefined}
    />,
  );
  expect(screen.getByTestId("manifest-signature").textContent).toContain(
    "The signature is invalid: The lockfile was changed after it was signed.",
  );
  expect(screen.queryByRole("button", { name: "Trust key" }) === null).toBe(true);
});
