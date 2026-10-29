import type { InstalledPlugin } from "./types";

export function selectFirstMessageModelResolver(plugins: InstalledPlugin[], serverId: string) {
  const resolvers = plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) => plugin.firstMessageModelResolvers);
  if (resolvers.length > 1)
    throw new Error("Multiple plugins registered a first message model resolver");
  return resolvers[0]?.resolve ?? null;
}
