import { DaemonRpcError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TaskConversationDelivery } from "@getpaseo/protocol/messages";
import type { ComposerTaskConversationTransport } from "@/composer/actions";

const TASK_CONVERSATION_ERRORS: Readonly<Record<string, string>> = {
  "Task member is busy; stop the current round before handing over":
    "当前角色还在工作，请先停止当前轮次后接手。",
};

export function taskConversationSendErrorMessage(message: string): string {
  return TASK_CONVERSATION_ERRORS[message] ?? message;
}

interface TaskConversationSendInput {
  client: Pick<DaemonClient, "sendTaskConversationMessage" | "getTaskConversationDelivery">;
  message: Parameters<ComposerTaskConversationTransport["send"]>[0];
  onDelivery: (delivery: TaskConversationDelivery) => void;
  onUncertain: (clientMessageId: string, message: string) => void;
}

export async function sendTaskConversationSubmission(
  input: TaskConversationSendInput,
): Promise<void> {
  let response: Awaited<
    ReturnType<TaskConversationSendInput["client"]["sendTaskConversationMessage"]>
  >;
  try {
    response = await input.client.sendTaskConversationMessage(input.message);
  } catch (error) {
    if (error instanceof DaemonRpcError) {
      throw new Error(
        taskConversationSendErrorMessage(error.serverMessage.replace(/^Request failed: /, "")),
        { cause: error },
      );
    }
    try {
      response = await input.client.getTaskConversationDelivery({
        conversationId: input.message.conversationId,
        clientMessageId: input.message.clientMessageId,
      });
    } catch {
      input.onUncertain(
        input.message.clientMessageId,
        "投递结果尚不明确，请查询回执后继续；不要重复发送。",
      );
      return;
    }
    if (!response.delivery) {
      input.onUncertain(
        input.message.clientMessageId,
        "暂未查到投递回执，请稍后重新查询；不要重复发送。",
      );
      return;
    }
  }
  if (!response.delivery) {
    throw new Error(
      taskConversationSendErrorMessage(response.error ?? "发送失败，宿主没有返回投递回执。"),
    );
  }
  const delivery = response.delivery;
  input.onDelivery(delivery);
  if (delivery.status === "rejected") {
    throw new Error(
      taskConversationSendErrorMessage(
        delivery.error ?? response.error ?? "宿主拒绝了本次接手请求。",
      ),
    );
  }
  if (delivery.status !== "accepted") {
    input.onUncertain(
      delivery.clientMessageId,
      delivery.error ?? "投递尚未确认，请查询回执后继续；不要重复发送。",
    );
  }
}
