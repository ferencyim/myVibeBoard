export function findBotForAgent<T extends { mainAgentId: string | null }>(bots: readonly T[], agentId: string): T | undefined {
  return bots.find((bot) => bot.mainAgentId === agentId);
}
