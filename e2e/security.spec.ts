import { expect, test } from "@playwright/test";
import { openDevice } from "./helpers.ts";

test("security headers are present on every response", async ({ request }) => {
  for (const path of ["/", "/healthz", "/does-not-exist"]) {
    const res = await request.get(path);
    const h = res.headers();
    expect(h["content-security-policy"], path).toContain("default-src 'none'");
    expect(h["content-security-policy"], path).toContain("require-trusted-types-for 'script'");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["referrer-policy"], path).toBe("no-referrer");
    expect(h["cross-origin-opener-policy"], path).toBe("same-origin");
  }
});

test("CSP and Trusted Types block script injection in the live app", async ({ browser }) => {
  const device = await openDevice(browser);
  try {
    const result = await device.page.evaluate(() => {
      const out: Record<string, string> = {};
      try {
        document.body.insertAdjacentHTML("beforeend", "<img src=x onerror=alert(1)>");
        out.html = "allowed";
      } catch {
        out.html = "blocked";
      }
      const s = document.createElement("script");
      try {
        s.textContent = "window.__pwned = true";
        document.head.append(s);
      } catch {
        // Trusted Types may throw here instead.
      }
      out.inline = (window as unknown as { __pwned?: boolean }).__pwned ? "allowed" : "blocked";
      return out;
    });
    expect(result).toEqual({ html: "blocked", inline: "blocked" });
    // eval() cannot be exercised from page.evaluate (DevTools-originated code is
    // exempt), so assert the policy itself never allows it.
    const csp = (await device.page.request.get("/")).headers()["content-security-policy"]!;
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline");
  } finally {
    await device.close();
  }
});

test("the WebSocket refuses cross-origin pages", async ({ browser, baseURL }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("about:blank");
  const outcome = await page.evaluate(
    (url) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(url);
        ws.onopen = () => resolve("open");
        ws.onerror = () => resolve("error");
      }),
    baseURL!.replace("http", "ws") + "/ws",
  );
  expect(outcome).toBe("error");
});
