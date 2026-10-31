import { Button } from "@/components/ui/button";

export function RefreshModelsButton({
  onRefresh,
  isLoading,
  disabled = false,
}: {
  onRefresh: () => void;
  isLoading: boolean;
  disabled?: boolean;
}) {
  return (
    <Button variant="ghost" size="xs" onPress={onRefresh} disabled={isLoading || disabled}>
      {isLoading ? "正在刷新模型…" : "刷新模型列表"}
    </Button>
  );
}
