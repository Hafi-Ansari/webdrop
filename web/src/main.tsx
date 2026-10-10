import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Controller } from "./lib/controller.ts";
import { detectDevice } from "./lib/device.ts";
import { tuning } from "./lib/tuning.ts";
import "./styles.css";
import { App } from "./ui/App.tsx";
import { Unsupported } from "./ui/Unsupported.tsx";

const root = createRoot(document.getElementById("root") as HTMLElement);

// WebCrypto (and therefore E2E encryption) only exists in secure contexts.
const supported = window.isSecureContext && typeof crypto?.subtle?.deriveBits === "function" && typeof RTCPeerConnection === "function";

if (!supported) {
  root.render(<Unsupported secure={window.isSecureContext} />);
} else {
  const controller = new Controller({
    url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    device: detectDevice(),
  });
  controller.start();
  root.render(
    <StrictMode>
      <App controller={controller} />
    </StrictMode>,
  );
  // Test/benchmark hooks exist only in builds made with VITE_E2E=1.
  if (import.meta.env.VITE_E2E === "1") {
    Object.assign(window, { __webdrop: { controller, tuning } });
  }
}
