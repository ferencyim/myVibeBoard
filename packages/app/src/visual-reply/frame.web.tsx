import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseVisualMessage } from "./message";

export function VisualReplyFrame({
  html,
  height,
  onDraft,
  theme,
}: {
  html: string;
  height: number;
  onDraft: (text: string) => void;
  theme: object;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [actualHeight, setActualHeight] = useState(height);
  useEffect(() => {
    setActualHeight(height);
  }, [height]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = parseVisualMessage(event.data);
      if (message?.type === "height") setActualHeight(Math.min(height, message.height));
      if (message?.type === "draft") onDraft(message.text);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [height, onDraft]);
  const sendTheme = useCallback(
    () => frame.current?.contentWindow?.postMessage({ type: "theme", theme }, "*"),
    [theme],
  );
  useEffect(() => {
    sendTheme();
  }, [sendTheme]);
  const style = useMemo(() => ({ width: "100%", height: actualHeight, border: 0 }), [actualHeight]);
  return (
    <iframe
      ref={frame}
      title="可视化回复"
      sandbox="allow-scripts"
      srcDoc={html}
      onLoad={sendTheme}
      style={style}
    />
  );
}
