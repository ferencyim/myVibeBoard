import {
  AdaptiveModalSheet,
  type AdaptiveModalSheetProps,
} from "@/components/adaptive-modal-sheet";

export function Sheet(props: AdaptiveModalSheetProps) {
  return <AdaptiveModalSheet {...props} forceSheet />;
}
export type {
  AdaptiveModalSheetProps as SheetProps,
  SheetHeader,
} from "@/components/adaptive-modal-sheet";
