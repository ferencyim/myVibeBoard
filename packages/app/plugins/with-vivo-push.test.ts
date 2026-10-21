import { describe, expect, it } from "vitest";

const {
  resolveVivoPushConfig,
  applyVivoManifest,
  applyVivoGradle,
  RECEIVER_KT,
  BRIDGE_KT,
} = require("./with-vivo-push");

function fakeFs(files: Record<string, string>) {
  const norm = (p: string) => p.replaceAll("\\", "/");
  return {
    existsSync: (p: string) => norm(p) in files,
    readFileSync: (p: string) => {
      if (!(norm(p) in files)) throw new Error("ENOENT");
      return files[norm(p)];
    },
    readdirSync: (dir: string) => {
      const prefix = `${norm(dir)}/`;
      const names = Object.keys(files)
        .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
        .map((f) => f.slice(prefix.length));
      if (names.length === 0) throw new Error("ENOENT");
      return names;
    },
  };
}

describe("resolveVivoPushConfig", () => {
  it("is null (vivo off) when nothing is configured", () => {
    expect(
      resolveVivoPushConfig({ env: {}, appDir: "/app", repoRoot: "/repo", fsImpl: fakeFs({}) }),
    ).toBeNull();
  });

  it("is null when the SDK is present but credentials are missing", () => {
    const fsImpl = fakeFs({ "/app/.secrets/vivo/sdk.aar": "" });
    expect(
      resolveVivoPushConfig({ env: {}, appDir: "/app", repoRoot: "/repo", fsImpl }),
    ).toBeNull();
  });

  it("reads aar and config.json from .secrets/vivo", () => {
    const fsImpl = fakeFs({
      "/repo/.secrets/vivo/vivo_push_sdk.aar": "",
      "/repo/.secrets/vivo/config.json": JSON.stringify({ appId: 123, appKey: "k" }),
    });
    const resolved = resolveVivoPushConfig({ env: {}, appDir: "/app", repoRoot: "/repo", fsImpl });
    expect(resolved).toMatchObject({ appId: "123", appKey: "k" });
    expect(resolved.aarPath.replaceAll("\\", "/")).toBe("/repo/.secrets/vivo/vivo_push_sdk.aar");
  });

  it("lets environment variables override the files", () => {
    const fsImpl = fakeFs({
      "/env/sdk.aar": "",
      "/app/.secrets/vivo/config.json": JSON.stringify({ appId: "file", appKey: "file" }),
    });
    const env = { VIVO_PUSH_SDK_AAR: "/env/sdk.aar", VIVO_APP_ID: "e1", VIVO_APP_KEY: "e2" };
    expect(resolveVivoPushConfig({ env, appDir: "/app", repoRoot: "/repo", fsImpl })).toEqual({
      aarPath: "/env/sdk.aar",
      appId: "e1",
      appKey: "e2",
    });
  });

  it("is null when the aar path does not exist", () => {
    const env = { VIVO_PUSH_SDK_AAR: "/missing.aar", VIVO_APP_ID: "1", VIVO_APP_KEY: "2" };
    expect(
      resolveVivoPushConfig({ env, appDir: "/app", repoRoot: "/repo", fsImpl: fakeFs({}) }),
    ).toBeNull();
  });
});

describe("applyVivoManifest", () => {
  const base = () => ({ manifest: { application: [{ $: {}, "meta-data": [] as unknown[] }] } });

  it("adds app id, api key and the message receiver once", () => {
    const manifest = base();
    applyVivoManifest(manifest, { appId: "105", appKey: "abc" });
    applyVivoManifest(manifest, { appId: "105", appKey: "abc" });
    const app = manifest.manifest.application[0] as unknown as {
      "meta-data": unknown;
      receiver: Array<{
        $: Record<string, string>;
        "intent-filter": Array<{ action: Array<{ $: Record<string, string> }> }>;
      }>;
    };
    expect(app["meta-data"]).toEqual([
      { $: { "android:name": "com.vivo.push.app_id", "android:value": "105" } },
      { $: { "android:name": "com.vivo.push.api_key", "android:value": "abc" } },
    ]);
    expect(app.receiver).toHaveLength(1);
    expect(app.receiver[0].$["android:name"]).toBe("sh.paseo.vivo.PaseoVivoPushReceiver");
    expect(app.receiver[0]["intent-filter"][0].action[0].$["android:name"]).toBe(
      "com.vivo.pushclient.action.RECEIVE",
    );
  });
});

describe("applyVivoGradle", () => {
  it("adds the local aar dependency once", () => {
    const source = "android {}\ndependencies {\n    implementation 'x'\n}\n";
    const once = applyVivoGradle(source);
    expect(once).toContain('implementation(files("libs/vivo_push.aar"))');
    expect(applyVivoGradle(once)).toBe(once);
  });

  it("fails loudly when there is no dependencies block", () => {
    expect(() => applyVivoGradle("android {}")).toThrow(/dependencies/);
  });
});

describe("generated Kotlin", () => {
  it("lives in the package the JS module reflects on", () => {
    expect(RECEIVER_KT).toContain("package sh.paseo.vivo");
    expect(BRIDGE_KT).toContain("object VivoPushBridge");
    expect(BRIDGE_KT).toContain("@JvmStatic");
  });
});
