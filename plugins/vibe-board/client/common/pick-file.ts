import { Platform } from "react-native";

// This plugin typechecks without the DOM library; declare only what the web picker touches.
declare const document: {
  createElement(tag: "input"): {
    type: string;
    accept: string;
    onchange: (() => void) | null;
    files: ArrayLike<{
      name: string;
      type: string;
      size: number;
      arrayBuffer(): Promise<ArrayBuffer>;
    }> | null;
    click(): void;
  };
};
declare function btoa(data: string): string;

export interface PickedFile {
  fileName: string;
  mime: string;
  base64: string;
}

/** Web only: Android has no file picker in the plugin sandbox, so callers hide the button there. */
export const canPickFile = Platform.OS === "web";

export function pickImage(): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      resolve({ fileName: file.name, mime: file.type || "image/png", base64: btoa(binary) });
    };
    input.click();
  });
}
