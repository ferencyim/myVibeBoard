export function suggestedModel(providers: Array<{ provider: string; models: Array<{ id: string; name: string }> }>) {
  const candidates = providers.flatMap((p) => p.models.map((m) => ({ provider: p.provider, model: m.id, name: m.name })));
  return candidates.find((m) => /haiku|nano|mini|flash|small|lite|spark/i.test(`${m.model} ${m.name}`));
}

export function modelChoices(models: ReadonlyArray<{ id: string; name: string }> | undefined, showEmpty = false) {
  return [{ label: showEmpty && !models?.length ? "暂无缓存模型（可稍后重试或改选其它 provider）" : "请选择模型", value: "" }, ...(models ?? []).map((model) => ({ label: model.name, value: model.id }))];
}
