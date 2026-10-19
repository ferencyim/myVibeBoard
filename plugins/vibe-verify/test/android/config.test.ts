import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadVerifyConfig } from "../../server/collectors/common";

it("reads the android section of .vibe/verify.json", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-cfg-"));
  mkdirSync(path.join(dir, ".vibe"));
  writeFileSync(
    path.join(dir, ".vibe", "verify.json"),
    JSON.stringify({
      android: {
        app: { packageName: "com.x", metro: { command: "npx" } },
        flow: { steps: [{ type: "tap", x: 1, y: 2 }] },
      },
    }),
  );
  const android = loadVerifyConfig(dir).android;
  expect(android?.app.mode).toBe("bundled");
  expect(android?.app.metro?.port).toBe(8081);
  expect(android?.flow?.steps).toHaveLength(1);
});
