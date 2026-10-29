export function suggestedModel(providers: Array<{ provider: string; models: Array<{ id: string; name: string }> }>) {
  const candidates = providers.flatMap((p) => p.models.map((m) => ({ provider: p.provider, model: m.id, name: m.name })));
  return candidates.find((m) => /haiku|nano|mini|flash|small|lite|spark/i.test(`${m.model} ${m.name}`));
}
