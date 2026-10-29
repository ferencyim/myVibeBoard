import { beforeEach, describe, expect, it } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { cacheBranchSuggestions, readCachedBranchSuggestions } from "./branch-suggestions-cache";
beforeEach(async () => {
  await AsyncStorage.clear();
});
describe("offline branch suggestions", () => {
  it("persists a successful listing, filters offline and isolates host and project", async () => {
    await cacheBranchSuggestions("host-one", "/repo", {
      branches: ["main", "feature"],
      branchDetails: [{ name: "feature", committerDate: 12 }],
      requestId: "r",
      error: null,
    });
    await expect(readCachedBranchSuggestions("host-one", "/repo", "FEAT")).resolves.toMatchObject({
      branches: ["feature"],
      branchDetails: [{ name: "feature", committerDate: 12 }],
    });
    await cacheBranchSuggestions("host-one", "/repo", {
      branches: [],
      requestId: "r",
      error: "offline",
    });
    await expect(readCachedBranchSuggestions("host-one", "/repo", "")).resolves.toMatchObject({
      branches: ["main", "feature"],
    });
    await expect(readCachedBranchSuggestions("host-two", "/repo", "")).resolves.toBeNull();
    await expect(readCachedBranchSuggestions("host-one", "/other", "")).resolves.toBeNull();
  });
});
