import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import { queryKey } from "../common/api";
import { useHost } from "../common/ctx";
import { quotaFor, type ProviderUsageLike } from "./logic";

/**
 * Remaining agent quota from `paseo.providers.listUsage()`. Resolves to null when the host cannot
 * report usage (old daemon, no subscription data, request failed): callers then show nothing.
 */
export function useProviderUsage(): ProviderUsageLike[] | null {
  const paseo = usePaseo();
  const query = useQuery({
    queryKey: queryKey("provider-usage"),
    queryFn: async () => (await paseo.providers.listUsage()).providers as ProviderUsageLike[],
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  return query.data ?? null;
}

/** "5h 73%" next to a provider name; renders nothing when the quota is unknown. */
export function QuotaBadge({
  provider,
  usage,
}: {
  provider: string;
  usage: readonly ProviderUsageLike[] | null;
}) {
  const { theme } = useHost();
  const quota = quotaFor(provider, usage);
  if (!quota) return null;
  const color =
    quota.tone === "danger"
      ? theme.colors.statusDanger
      : quota.tone === "warning"
        ? theme.colors.statusWarning
        : theme.colors.statusSuccess;
  return (
    <View
      accessibilityLabel={`剩余额度 ${quota.text}`}
      style={{
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color,
        paddingHorizontal: 6,
        paddingVertical: 1,
      }}
    >
      <Text style={{ color, fontSize: 11 }}>余 {quota.text}</Text>
    </View>
  );
}
