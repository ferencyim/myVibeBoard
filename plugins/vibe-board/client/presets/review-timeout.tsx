import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput } from "@getpaseo/plugin/client/ui";
import React, { useCallback } from "react";
import { boardSettings } from "../../shared/settings";

export function ReviewTimeoutField() {
  const settings = useSettings(boardSettings);
  const onChangeText = useCallback((text: string) => {
    if (settings.status !== "ready") return;
    const minutes = Number(text.trim());
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) return;
    void settings.save({ ...settings.values, planReviewTimeoutMinutes: minutes }, settings.revision);
  }, [settings]);
  if (settings.status !== "ready") return null;
  return (
    <SettingsCard>
      <SettingsInput
        label="方案审阅者单人超时（分钟，1-240；超时按失败处理并换候选模型）"
        initialValue={String(settings.values.planReviewTimeoutMinutes)}
        onChangeText={onChangeText}
      />
    </SettingsCard>
  );
}
