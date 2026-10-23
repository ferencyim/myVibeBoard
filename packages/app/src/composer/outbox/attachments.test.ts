import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentMetadata, AttachmentStore, ComposerAttachment } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import { collectOutboxAttachmentIds, prepareOutboxAttachments } from "./attachments";

function image(id: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/png",
    storageType: "native-file",
    storageKey: "/attachments/" + id,
    fileName: id + ".png",
    createdAt: 1700000000000,
  };
}

function browserElement(screenshot?: AttachmentMetadata): ComposerAttachment {
  return {
    kind: "browser_element",
    attachment: {
      url: "https://example.test",
      selector: "button",
      tag: "button",
      text: "提交",
      outerHTML: "<button>提交</button>",
      computedStyles: {},
      boundingRect: { x: 0, y: 0, width: 100, height: 30 },
      reactSource: null,
      parentChain: [],
      children: [],
      formatted: "检查提交按钮",
      ...(screenshot ? { screenshot } : {}),
    },
  };
}

afterEach(() => __setAttachmentStoreForTests(null));

describe("outbox attachment preparation", () => {
  it("rejects the entire first message when one image is missing", async () => {
    const attachments: ComposerAttachment[] = [
      { kind: "image", metadata: image("ready") },
      { kind: "image", metadata: image("missing") },
    ];
    const before = JSON.stringify(attachments);
    const encoded: AttachmentMetadata[] = [];
    const encodeBase64 = async (attachment: AttachmentMetadata) => {
      encoded.push(attachment);
      if (attachment.id === "missing") throw new Error("file missing");
      return "aW1hZ2U=";
    };
    await expect(prepareOutboxAttachments({ attachments }, { encodeBase64 })).rejects.toThrow(
      "无法读取附件「missing.png」，首消息已保留",
    );
    expect(encoded.map((attachment) => attachment.id)).toEqual(["ready", "missing"]);
    expect(JSON.stringify(attachments)).toBe(before);
  });

  it("encodes persisted metadata after restart without a preview URL", async () => {
    const metadata = structuredClone(image("persisted"));
    const encoded: AttachmentMetadata[] = [];
    const encodeBase64 = async (attachment: AttachmentMetadata) => {
      encoded.push(attachment);
      return "aW1hZ2U=";
    };
    await expect(
      prepareOutboxAttachments({ attachments: [{ kind: "image", metadata }] }, { encodeBase64 }),
    ).resolves.toEqual({ images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] });
    expect(encoded).toEqual([metadata]);
  });

  it("uses the native attachment store by default", async () => {
    const metadata = image("native");
    const encoded: AttachmentMetadata[] = [];
    const store: AttachmentStore = {
      storageType: "native-file",
      async save() {
        throw new Error("本测试不保存附件");
      },
      async encodeBase64({ attachment }) {
        encoded.push(attachment);
        return "aW1hZ2U=";
      },
      async resolvePreviewUrl() {
        throw new Error("本测试不生成预览");
      },
      async delete() {},
      async garbageCollect() {},
    };
    __setAttachmentStoreForTests(store);
    await expect(
      prepareOutboxAttachments({ attachments: [{ kind: "image", metadata }] }),
    ).resolves.toEqual({ images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] });
    expect(encoded).toEqual([metadata]);
  });

  it("prepares browser screenshots with their text and fails if the screenshot is missing", async () => {
    const attachments = [browserElement(image("screenshot"))];
    const encodeBase64 = async () => "aW1hZ2U=";
    await expect(prepareOutboxAttachments({ attachments }, { encodeBase64 })).resolves.toEqual({
      images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          title: "Browser element · button",
          text: "检查提交按钮",
        },
      ],
    });
    await expect(
      prepareOutboxAttachments(
        { attachments },
        {
          encodeBase64: async () => {
            throw new Error("missing");
          },
        },
      ),
    ).rejects.toThrow("无法读取附件「screenshot.png」");
  });

  it("rejects empty local image content", async () => {
    await expect(
      prepareOutboxAttachments(
        { attachments: [{ kind: "image", metadata: image("empty") }] },
        { encodeBase64: async () => "" },
      ),
    ).rejects.toThrow("无法读取附件「empty.png」");
  });

  it("converts saved plugin resources without a plugin client or local image store", async () => {
    const attachment: ComposerAttachment = {
      kind: "plugin_resource",
      pluginId: "issues",
      sourceId: "tickets",
      sourceTitle: "问题",
      sourceIcon: "CircleDot",
      item: {
        id: "1",
        identifier: "TASK-1",
        title: "修复按钮",
        text: "保存的完整上下文",
        resourceType: "issue",
        url: "https://example.test/1",
      },
    };
    await expect(
      prepareOutboxAttachments(
        { attachments: [attachment] },
        {
          encodeBase64: async () => {
            throw new Error("本测试不得读取图片");
          },
        },
      ),
    ).resolves.toEqual({
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          title: "TASK-1 修复按钮",
          text: "保存的完整上下文",
          externalResource: {
            provider: "issues",
            providerLabel: "问题",
            resourceType: "issue",
            id: "1",
            identifier: "TASK-1",
            title: "修复按钮",
            url: "https://example.test/1",
          },
        },
      ],
    });
  });

  it("does not open local attachment storage for an empty entry", async () => {
    await expect(
      prepareOutboxAttachments(
        { attachments: [] },
        {
          encodeBase64: async () => {
            throw new Error("本测试不得读取图片");
          },
        },
      ),
    ).resolves.toEqual({});
  });
});

describe("outbox attachment retention", () => {
  it("retains all local image and screenshot IDs across entries without duplicates", () => {
    const ids = collectOutboxAttachmentIds([
      {
        attachments: [{ kind: "image", metadata: image("image") }, browserElement(image("screen"))],
      },
      { attachments: [{ kind: "image", metadata: image("image") }, browserElement()] },
    ]);
    expect([...ids]).toEqual(["image", "screen"]);
  });
});
