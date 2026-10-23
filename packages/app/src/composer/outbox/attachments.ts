import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { getAttachmentStore } from "@/attachments/store";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import {
  splitComposerAttachmentsForSubmit,
  type ComposerAttachmentSubmitFormat,
} from "@/composer/attachments/submit";

interface OutboxAttachmentOptions {
  format?: ComposerAttachmentSubmitFormat;
  encodeBase64?: (attachment: AttachmentMetadata) => Promise<string>;
}

export async function prepareOutboxAttachments(
  entry: { attachments: readonly ComposerAttachment[] },
  options: OutboxAttachmentOptions = {},
): Promise<{
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
}> {
  const payload = splitComposerAttachmentsForSubmit([...entry.attachments], {
    format: options.format,
  });
  const encodeBase64 =
    options.encodeBase64 ??
    (async (attachment: AttachmentMetadata) => {
      const store = await getAttachmentStore();
      return await store.encodeBase64({ attachment });
    });
  // Reject the whole preparation: a missing local image must never silently
  // turn the saved first message into a partial submission.
  const images = await Promise.all(
    payload.images.map(async (attachment) => {
      try {
        const data = await encodeBase64(attachment);
        if (!data) {
          throw new Error("附件内容为空");
        }
        return { data, mimeType: attachment.mimeType };
      } catch {
        throw new Error(
          "无法读取附件「" +
            (attachment.fileName || attachment.id) +
            "」，首消息已保留，请恢复或移除附件后重试。",
        );
      }
    }),
  );
  return {
    ...(images.length > 0 ? { images } : {}),
    ...(payload.attachments.length > 0 ? { attachments: payload.attachments } : {}),
  };
}

export function collectOutboxAttachmentIds(
  entries: readonly { attachments: readonly ComposerAttachment[] }[],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const attachment of entry.attachments) {
      if (attachment.kind === "image") {
        ids.add(attachment.metadata.id);
      } else if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
        ids.add(attachment.attachment.screenshot.id);
      }
    }
  }
  return ids;
}
