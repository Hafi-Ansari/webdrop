import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4173);
/** Point at an already-running deployment (e.g. the Docker image) instead of starting one. */
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: external ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    acceptDownloads: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // Expose real host candidates so two headless contexts can connect
          // without relying on mDNS resolution.
          args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
        },
      },
    },
  ],
  webServer: external
    ? undefined
    : {
    // An e2e build exposes window.__webdrop for fault injection and tuning.
    command: `VITE_E2E=1 VITE_OUT_DIR=dist-e2e npm run build && STATIC_DIR=web/dist-e2e PORT=${PORT} HOST=127.0.0.1 STUN_URLS= LOG_LEVEL=warn node server/src/index.ts`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
