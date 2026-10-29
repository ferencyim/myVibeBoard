import {
  AdaptiveModalSheet,
  type AdaptiveModalSheetProps,
} from "@/components/adaptive-modal-sheet";

/** The shared adaptive surface: a bottom sheet on compact screens, a card on desktop. */
export function Sheet(props: AdaptiveModalSheetProps) {
  return <AdaptiveModalSheet {...props} />;
}
export type {
  AdaptiveModalSheetProps as SheetProps,
  SheetHeader,
} from "@/components/adaptive-modal-sheet";
