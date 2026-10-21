import { describe, expect, test } from "vitest";
import { formatRpcError } from "../ui/rpc-error";
import { thinkingLabel } from "../ui/thinking";

describe("formatRpcError", () => {
  test("strips the host prefix, the [code] tag and the requestType/code suffix", () => {
    const raw = new Error(
      "Request failed: [invalid] 这张卡还没有选执行预设，项目也没有默认预设，请先选择预设 requestType=plugin.rpc.invoke.request code=handler_error",
    );
    expect(formatRpcError(raw)).toBe("这张卡还没有选执行预设，项目也没有默认预设，请先选择预设");
  });

  test("translates shared English messages", () => {
    const wrap = (m: string) =>
      new Error(`Request failed: ${m} requestType=plugin.rpc.invoke.request code=handler_error`);
    expect(formatRpcError(wrap("[not_found] Card not found: TST-9"))).toBe("找不到卡片：TST-9");
    expect(formatRpcError(wrap('[conflict] Preset "A" already exists'))).toBe("预设“A”已存在");
    expect(formatRpcError(wrap('[illegal_transition] Cards cannot move from "draft" to "done"'))).toBe(
      "卡片不能从“草稿箱”直接移到“已完成”",
    );
    expect(formatRpcError(wrap("[invalid] Card title is required"))).toBe("卡片标题不能为空");
  });

  test("an unknown English message keeps its text under the code label", () => {
    expect(formatRpcError(new Error("[conflict] something odd"))).toBe("操作冲突：something odd");
    expect(formatRpcError(new Error("plain failure"))).toBe("plain failure");
    expect(formatRpcError("[unavailable] Daemon down")).toBe("暂不可用：Daemon down");
  });

  test("empty and non-Error inputs still give a sentence", () => {
    expect(formatRpcError(new Error("[invalid]"))).toBe("输入无效");
    expect(formatRpcError(new Error(""))).toBe("操作失败");
  });
});

describe("thinkingLabel", () => {
  test("codex 'low' and claude 'Low' read the same", () => {
    expect(thinkingLabel({ id: "low", label: "low" })).toBe("低");
    expect(thinkingLabel({ id: "low", label: "Low" })).toBe("低");
    expect(thinkingLabel({ id: "xhigh" })).toBe("很高");
  });

  test("a Chinese provider label wins; an English label does not override a known level", () => {
    expect(thinkingLabel({ id: "high", label: "深度思考" })).toBe("深度思考");
    expect(thinkingLabel({ id: "xhigh", label: "Extra High" })).toBe("很高");
    expect(thinkingLabel({ id: "ultra", label: "Ultra Code" })).toBe("极高");
    expect(thinkingLabel({ id: "turbo", label: "Turbo mode" })).toBe("Turbo mode");
  });

  test("covers the known levels and shows unknown ids as is", () => {
    const names = ["low", "medium", "high", "xhigh", "max", "ultra"].map((id) => thinkingLabel({ id }));
    expect(names).toEqual(["低", "中", "高", "很高", "最高", "极高"]);
    expect(thinkingLabel({ id: "turbo", label: "turbo" })).toBe("turbo");
    expect(thinkingLabel({ id: "turbo" })).toBe("turbo");
  });
});
