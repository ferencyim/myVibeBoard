import React, { useCallback, useEffect, useMemo, useState } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { parseVisualMessage } from "./message";

const origins = ["about:blank"];
const allowNavigation = (request: ShouldStartLoadRequest) => request.url === "about:blank";
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
  const [actualHeight, setActualHeight] = useState(height);
  useEffect(() => {
    setActualHeight(height);
  }, [height]);
  const source = useMemo(
    () => ({
      html: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'">${html}`,
    }),
    [html],
  );
  const style = useMemo(() => ({ height: actualHeight }), [actualHeight]);
  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const message = parseVisualMessage(JSON.parse(event.nativeEvent.data));
        if (message?.type === "height") setActualHeight(Math.min(height, message.height));
        if (message?.type === "draft") onDraft(message.text);
      } catch {
        /* Ignore malformed messages. */
      }
    },
    [height, onDraft],
  );
  const injected = useMemo(
    () =>
      `window.dispatchEvent(new MessageEvent("message", {data: ${JSON.stringify({ type: "theme", theme })}})); true;`,
    [theme],
  );
  return (
    <WebView
      injectedJavaScript={injected}
      source={source}
      style={style}
      originWhitelist={origins}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      onShouldStartLoadWithRequest={allowNavigation}
      onMessage={onMessage}
    />
  );
}
