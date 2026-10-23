import type {
  CollectorContext as CardCollectorContext,
  TaskCollectorContext,
  EvidenceCollector,
  CollectorRegistry,
  ProjectType,
} from "../vibe/contract";
export type CollectorContext = CardCollectorContext | TaskCollectorContext;
export interface TaskEvidenceCollector extends Omit<
  EvidenceCollector,
  "detect" | "collect" | "dispose"
> {
  detect(ctx: CollectorContext): ReturnType<EvidenceCollector["detect"]>;
  collect(ctx: CollectorContext): ReturnType<EvidenceCollector["collect"]>;
  dispose?(ctx: CollectorContext): Promise<void>;
}
// Every collector registered by this plugin accepts both contexts. External collectors keep the
// legacy contract and are not enrolled into the native task pipeline.
export function taskCollectors(
  registry: CollectorRegistry,
  type: ProjectType,
): TaskEvidenceCollector[] {
  return registry.forProjectType(type) as TaskEvidenceCollector[];
}
