const frameStyle = { flex: 1, minHeight: 0, border: "none", backgroundColor: "white" } as const;

/** An opaque origin prevents the document from accessing the app or its storage. */
export function DocumentFrame({ url, testID }: { url: string; testID?: string }) {
  if (!url.startsWith("blob:")) return null;
  return (
    <iframe
      title="Document preview"
      data-testid={testID}
      src={url}
      sandbox=""
      referrerPolicy="no-referrer"
      style={frameStyle}
    />
  );
}
