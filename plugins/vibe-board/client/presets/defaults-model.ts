import { cleanDefaults, plannerList, type ModelDefaults } from "../../shared/vibe/contract";

export const DEFAULT_MODEL_FIELDS = [
  ["main", "#1 主会话"],
  ["project", "项目 agent"],
  ["scout", "#3 探路"],
  ["worker", "#4 执行"],
  ["reviewer", "#5 复核"],
  ["verifier", "#6 验证"],
] as const;
export type DefaultModelField = (typeof DEFAULT_MODEL_FIELDS)[number][0];
export const INHERIT = "__inherit__";
export const DISABLED = "__disabled__";

export function setModelDefault(
  value: ModelDefaults,
  role: DefaultModelField,
  selection: string,
): ModelDefaults {
  const next = { ...value };
  if (selection === INHERIT) delete next[role];
  else if (selection === DISABLED && (role === "scout" || role === "reviewer")) next[role] = null;
  else if (selection !== DISABLED) next[role] = selection;
  return cleanDefaults(next);
}
export function inheritedDefaultLabel(
  role: DefaultModelField,
  global: ModelDefaults,
  nameOf: (id: string) => string,
): string {
  const id = global[role];
  if (id === null) return "沿用全局：不启用";
  if (id) return "沿用全局：" + nameOf(id);
  return "沿用全局：" + (role === "main" ? "守护进程默认模型" : "沿用 #1 模型");
}
export function openDefaultsForm(initial: ModelDefaults) {
  let saved = cleanDefaults(initial);
  let state = { value: saved, dirty: false };
  const listeners = new Set<() => void>();
  const publish = (value: ModelDefaults) => {
    const clean = cleanDefaults(value);
    state = { value: clean, dirty: JSON.stringify(clean) !== JSON.stringify(saved) };
    listeners.forEach((fn) => fn());
  };
  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    change: publish,
    reset: () => publish(saved),
    saved(value: ModelDefaults) {
      saved = cleanDefaults(value);
      publish(saved);
    },
    close: () => listeners.clear(),
  };
}
export function defaultPlannerLabel(global: ModelDefaults, nameOf: (id: string) => string) {
  return "沿用全局：" + ((plannerList(global) ?? []).map(nameOf).join(" → ") || "沿用 #1 模型");
}
