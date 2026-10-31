export function isCoordinatorConversation(bots: readonly { id: string; role: string | null; mainAgentId: string | null }[], agentId: string, botId?: string) {
  return bots.some((bot) => bot.role === "coordinator" && (bot.mainAgentId === agentId || (!!botId && bot.id === botId)));
}
