import { beforeEach, describe, expect, it } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  classificationCacheKey,
  rememberClassification,
} from "@/components/sidebar/sidebar-classification-cache";

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("sidebar classification cache", () => {
  it("persists the last answer per host and project", async () => {
    const key = classificationCacheKey("srv", "proj");
    rememberClassification(key, [{ workspaceId: "w1", kind: "task", phaseLabel: "执行" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stored = JSON.parse(
      (await AsyncStorage.getItem("@vibe/sidebar-classification/v1")) ?? "{}",
    );
    expect(stored[key]).toEqual([{ workspaceId: "w1", kind: "task", phaseLabel: "执行" }]);
  });
});
