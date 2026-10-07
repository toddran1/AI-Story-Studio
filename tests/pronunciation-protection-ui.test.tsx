/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PronunciationActions } from "../apps/web/src/PronunciationActions.js";
it("explains manual protection separately from the lock and leaves audio testing available", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(<PronunciationActions slug="test" id="one" locked protectionReason="manual" onEnriched={() => undefined} />));
    expect(host.querySelector('[role="note"]')?.textContent).toContain("Manual pronunciation protected");
    expect(host.textContent).toContain("Custom spoken form above");
    expect(host.querySelector("button")?.disabled).toBe(false);
    expect(host.querySelector("button")?.textContent).toContain("Test pronunciation");
    await act(async () => root.render(<PronunciationActions slug="test" id="one" locked protectionReason="locked" onEnriched={() => undefined} />));
    expect(host.textContent).toContain("Uncheck it above and save");
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
