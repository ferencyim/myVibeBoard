/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { VisualReplyFrame } from "./frame.web";

const theme = {};
const onDraft = () => {};
describe("visual reply iframe", () => {
  it("isolates scripts and caps reported heights to the requested maximum", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <VisualReplyFrame html="<p>hello</p>" height={300} onDraft={onDraft} theme={theme} />,
      ),
    );
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.style.height).toBe("300px");
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "height", height: 1000 },
        }),
      ),
    );
    expect(frame.style.height).toBe("300px");
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "height", height: 120 },
        }),
      ),
    );
    expect(frame.style.height).toBe("120px");
    await act(async () => root.unmount());
    container.remove();
  });
});
