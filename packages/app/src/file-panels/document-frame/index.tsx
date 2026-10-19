import { useCallback, useMemo, useRef } from "react";
import { WebView } from "react-native-webview";

const frameStyle = { flex: 1, backgroundColor: "white" };
const originWhitelist = ["*"];

export function DocumentFrame({ url, testID }: { url: string; testID?: string }) {
  const source = useMemo(() => ({ uri: url }), [url]);
  const loaded = useRef<string | null>(null);
  const allowDocument = useCallback(
    (request: { url: string }) => {
      if (!url.startsWith("file:") || request.url !== url || loaded.current === url) return false;
      loaded.current = url;
      return true;
    },
    [url],
  );
  if (!url.startsWith("file:")) return null;
  return (
    <WebView
      testID={testID}
      style={frameStyle}
      source={source}
      originWhitelist={originWhitelist}
      onShouldStartLoadWithRequest={allowDocument}
      javaScriptEnabled={false}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
      allowFileAccess
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      allowingReadAccessToURL={url}
    />
  );
}
