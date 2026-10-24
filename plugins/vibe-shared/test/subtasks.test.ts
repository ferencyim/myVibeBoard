import { describe, expect, it } from "vitest";
import { subtaskListError } from "../contract/subtasks";
const st = (id: string, patch: { dependsOn?: string[] } = {}) => ({
  id,
  dependsOn: patch.dependsOn ?? [],
});
describe("task dependency rules", () => {
  it("validates ids, dependencies and cycles", () => {
    expect(subtaskListError([st("s1"), st("s2", { dependsOn: ["s1"] })])).toBeNull();
    expect(subtaskListError([st("s1"), st("s1")])).toContain("重复");
    expect(subtaskListError([st("s1", { dependsOn: ["s9"] })])).toContain("不存在");
    expect(subtaskListError([st("s1", { dependsOn: ["s1"] })])).toContain("自己");
    expect(
      subtaskListError([
        st("s1", { dependsOn: ["s3"] }),
        st("s2", { dependsOn: ["s1"] }),
        st("s3", { dependsOn: ["s2"] }),
      ]),
    ).toContain("成环");
  });
});
