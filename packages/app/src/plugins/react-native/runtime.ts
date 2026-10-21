import { Icon } from "../icons";
import { Markdown } from "./markdown";
import { Modal } from "./modal";
import { ScrollView, FlatList } from "./scroll-view";
import { TextInput } from "./text-input";
import { copyText } from "./clipboard";
import { useToast } from "./toast";
import { useRevealedText } from "@/hooks/use-revealed-text";

export const pluginReactNativeRuntime = {
  Icon,
  Markdown,
  Modal,
  ScrollView,
  FlatList,
  TextInput,
  copyText,
  useRevealedText,
  useToast,
};
