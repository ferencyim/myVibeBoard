import { Button } from "@/components/ui/button";

export function RefreshModelsButton({
  onRefresh,
  isLoading,
}: {
  onRefresh?: () => void;
  isLoading: boolean;
}) {
  return onRefresh ? (
    <Button variant="ghost" size="xs" onPress={onRefresh} disabled={isLoading}>
      刷新模型列表
    </Button>
  ) : null;
}
