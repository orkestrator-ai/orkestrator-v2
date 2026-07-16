import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  availableSimulatorNames,
  builtApplicationPath,
  compareRuntimeDescending,
  parseSimulatorArguments,
  runtimeVersion,
  selectFirstAvailableSimulator,
  selectSimulatorDevice,
  type SimulatorDevice,
  type SimulatorList,
} from "../../scripts/run-ios-simulator";

const root = path.resolve(import.meta.dir, "../..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

function device(name: string, udid: string, state = "Shutdown", isAvailable = true): SimulatorDevice {
  return {
    dataPath: "/tmp/data",
    dataPathSize: 0,
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone",
    isAvailable,
    logPath: "/tmp/log",
    logPathSize: 0,
    name,
    state,
    udid,
  };
}

function pngDimensions(relativePath: string): [number, number] {
  const data = readFileSync(path.join(root, relativePath));
  expect(data.subarray(1, 4).toString()).toBe("PNG");
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

describe("iOS simulator orchestration", () => {
  test("parses device, default, separator, help, and missing-value arguments", () => {
    expect(parseSimulatorArguments([], "Default Phone")).toEqual({ deviceName: "Default Phone", help: false });
    expect(parseSimulatorArguments(["--", "--device", "iPhone 18"])).toEqual({
      deviceName: "iPhone 18",
      help: false,
    });
    expect(parseSimulatorArguments(["--help"])).toEqual({ deviceName: "iPhone 17 Pro", help: true });
    expect(() => parseSimulatorArguments(["--device"])).toThrow("Expected a simulator name");
  });

  test("orders runtimes numerically and selects the newest available exact-name device", () => {
    expect(runtimeVersion("com.apple.CoreSimulator.SimRuntime.iOS-26-1")).toEqual([26, 1]);
    expect(runtimeVersion("unknown")).toEqual([0]);
    expect([
      "com.apple.CoreSimulator.SimRuntime.iOS-18-5",
      "com.apple.CoreSimulator.SimRuntime.iOS-26-1",
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
    ].sort(compareRuntimeDescending)).toEqual([
      "com.apple.CoreSimulator.SimRuntime.iOS-26-1",
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      "com.apple.CoreSimulator.SimRuntime.iOS-18-5",
    ]);

    const list: SimulatorList = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [device("iPhone Pro", "old")],
        "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [device("iPhone Pro", "new")],
        "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [device("iPhone Pro", "unavailable", "Shutdown", false)],
      },
    };
    expect(selectSimulatorDevice(list, "iPhone Pro")?.udid).toBe("new");
    expect(selectSimulatorDevice(list, "Missing")).toBeUndefined();
    expect(selectFirstAvailableSimulator(list)?.udid).toBe("new");
    expect(selectFirstAvailableSimulator(list, "iPad")).toBeUndefined();
  });

  test("lists unique available names and resolves the built application path", () => {
    const list: SimulatorList = {
      devices: {
        one: [device("Zulu", "1"), device("Alpha", "2")],
        two: [device("Zulu", "3"), device("Hidden", "4", "Shutdown", false)],
      },
    };
    expect(availableSimulatorNames(list)).toEqual(["Alpha", "Zulu"]);
    expect(builtApplicationPath("/tmp/derived")).toBe(
      "/tmp/derived/Build/Products/Debug-iphonesimulator/OrkestratorMobile.app",
    );
  });

  test("uses argument-array process spawning and fails closed on malformed simulator JSON", () => {
    const source = read("scripts/run-ios-simulator.ts");
    expect(source).toContain("spawnSync(command, args");
    expect(source).toContain('fail("xcrun returned malformed simulator JSON.")');
    expect(source).toContain('"CODE_SIGNING_ALLOWED=NO"');
    expect(source).toContain('if (import.meta.main) main()');

    const testSource = read("scripts/test-ios.ts");
    expect(testSource).toContain('spawnSync("xcodebuild", [');
    expect(testSource).toContain('selectFirstAvailableSimulator(simulatorList)');
    expect(testSource).not.toContain("CODE_SIGNING_ALLOWED=NO");
  });
});

describe("iOS project and deployment contracts", () => {
  test("root package exposes the tested Bun simulator command", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["dev:ios"]).toBe("bun scripts/run-ios-simulator.ts");
  });

  test("project and shared scheme include the app and unit-test targets", () => {
    const project = read("apps/ios/OrkestratorMobile.xcodeproj/project.pbxproj");
    const scheme = read("apps/ios/OrkestratorMobile.xcodeproj/xcshareddata/xcschemes/OrkestratorMobile.xcscheme");
    expect(project).toContain('A50000000000000000000002 /* OrkestratorMobileTests */');
    expect(project).toContain('productType = "com.apple.product-type.bundle.unit-test"');
    expect(project).toContain("OrkestratorMobileTests.swift in Sources");
    expect(scheme).toContain('BlueprintName="OrkestratorMobileTests"');
    expect(scheme).toContain('<TestableReference skipped="NO"');
  });

  test("every native source file belongs to the app or test target", () => {
    const project = read("apps/ios/OrkestratorMobile.xcodeproj/project.pbxproj");
    for (const file of [
      "OrkestratorMobileApp.swift",
      "RemoteConnection.swift",
      "ConnectionModel.swift",
      "KeychainCredentialStore.swift",
      "GatewayConnectionValidator.swift",
      "RootView.swift",
      "ConnectionEditorView.swift",
      "RemoteWebView.swift",
      "OrkestratorMobileTests.swift",
    ]) {
      expect(project).toContain(`${file} in Sources`);
    }
  });

  test("plist keeps HTTPS transport security and required app metadata", () => {
    const plist = read("apps/ios/OrkestratorMobile/Info.plist");
    expect(plist).toContain("<key>NSAllowsArbitraryLoads</key>\n\t\t<false/>");
    expect(plist).toContain("<key>NSLocalNetworkUsageDescription</key>");
    expect(plist).toContain("<key>CFBundleIdentifier</key>");
    expect(plist).toContain("<key>UISupportedInterfaceOrientations~ipad</key>");
  });

  test("asset catalogs reference existing PNGs with matching pixel dimensions", () => {
    const catalogPath = "apps/ios/OrkestratorMobile/Assets.xcassets/AppIcon.appiconset";
    const catalog = JSON.parse(read(`${catalogPath}/Contents.json`)) as {
      images: Array<{ filename?: string; scale: string; size: string }>;
    };
    for (const image of catalog.images) {
      expect(image.filename).toBeTruthy();
      const relativePath = `${catalogPath}/${image.filename}`;
      expect(existsSync(path.join(root, relativePath))).toBe(true);
      const [pointsWidth, pointsHeight] = image.size.split("x").map(Number);
      const scale = Number(image.scale.replace("x", ""));
      expect(pngDimensions(relativePath)).toEqual([pointsWidth * scale, pointsHeight * scale]);
    }

    const brand = JSON.parse(
      read("apps/ios/OrkestratorMobile/Assets.xcassets/BrandMark.imageset/Contents.json"),
    ) as { images: Array<{ filename?: string }> };
    const brandFile = brand.images.find((image) => image.filename)?.filename;
    expect(brandFile).toBe("BrandMark.png");
    expect(pngDimensions(`apps/ios/OrkestratorMobile/Assets.xcassets/BrandMark.imageset/${brandFile}`))
      .toEqual([512, 512]);
  });

  test("documentation and ignore policy cover prerequisites, secure storage, and build artifacts", () => {
    const docs = read("apps/ios/README.md");
    expect(docs).toContain("bun run dev:ios");
    expect(docs).toContain("kSecAttrAccessibleWhenUnlockedThisDeviceOnly");
    expect(docs).toContain("Plain HTTP and invalid TLS certificates are intentionally rejected");
    expect(docs).toContain("Switch saved server");

    const ignored = read("apps/ios/.gitignore").trim().split(/\r?\n/);
    expect(ignored).toEqual(["build/", "DerivedData/", "*.xcuserstate", "xcuserdata/"]);
  });
});

describe("iOS UI and WebKit security contracts", () => {
  test("failure UI exposes native saved-server recovery", () => {
    const source = read("apps/ios/OrkestratorMobile/Views/RootView.swift");
    expect(source).toContain('Label("Switch saved server", systemImage: "server.rack")');
    expect(source).toContain("try await model.use(connectionID:");
    expect(source).toContain("alternatives: model.vault.connections.filter");
  });

  test("connection editor covers secure fields, disabled submission, errors, and cancellation", () => {
    const source = read("apps/ios/OrkestratorMobile/Views/ConnectionEditorView.swift");
    expect(source).toContain("SecureField(");
    expect(source).toContain("model.connectionError");
    expect(source).toContain("model.dismissConnectionEditor()");
    expect(source).toContain(".disabled(model.isConnecting || model.draftAddress.isEmpty || model.draftToken.isEmpty)");
  });

  test("WebKit bridge is ephemeral, origin-scoped, and torn down authoritatively", () => {
    const source = read("apps/ios/OrkestratorMobile/Views/RemoteWebView.swift");
    expect(source).toContain("configuration.websiteDataStore = .nonPersistent()");
    expect(source).toContain("message.frameInfo.isMainFrame");
    expect(source).toContain("message.frameInfo.securityOrigin");
    expect(source).toContain("coordinator.teardown()");
    expect(source).toContain("authenticationTask?.cancel()");
    expect(source).toContain("Self.sameOrigin(url, requestedConnection.address)");
  });

  test("application entry point provides the shared model and forced dark appearance", () => {
    const source = read("apps/ios/OrkestratorMobile/OrkestratorMobileApp.swift");
    expect(source).toContain("@StateObject private var connectionModel");
    expect(source).toContain(".environmentObject(connectionModel)");
    expect(source).toContain(".preferredColorScheme(.dark)");
  });
});
