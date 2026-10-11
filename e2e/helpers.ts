import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, type Browser, type Page } from "@playwright/test";

export interface Device {
  page: Page;
  name: string;
  close(): Promise<void>;
}

/** Each device gets its own browser context (separate storage = separate identity). */
export async function openDevice(browser: Browser, baseURL?: string): Promise<Device> {
  const context = await browser.newContext({ acceptDownloads: true, ...(baseURL ? { baseURL } : {}) });
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on("pageerror", (err) => console.error(`[pageerror] ${err.message}`));
  await page.goto("/");
  await expect(page.getByTestId("connection")).toHaveAttribute("data-state", "open");
  const name = (await page.getByTestId("self-name").textContent())!.trim();
  return { page, name, close: () => context.close() };
}

export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

/** Write `size` random bytes to `path`; returns the SHA-256 hex digest. */
export async function makeFile(path: string, size: number): Promise<string> {
  const hash = createHash("sha256");
  const out = createWriteStream(path);
  const block = 1024 * 1024;
  for (let written = 0; written < size; written += block) {
    const chunk = randomBytes(Math.min(block, size - written));
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
  }
  await new Promise<void>((resolve, reject) => {
    out.once("error", reject);
    out.end(() => resolve());
  });
  return hash.digest("hex");
}

export async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function peerCard(page: Page, name: string) {
  return page.getByTestId("peer").filter({ has: page.getByTestId("peer-name").getByText(name, { exact: true }) });
}

/** Choose files for the peer called `name` (via its hidden file input). */
export async function sendTo(page: Page, name: string, files: string | string[]) {
  await expect(peerCard(page, name)).toBeVisible();
  await page.locator("li", { has: peerCard(page, name) }).getByTestId("file-input").setInputFiles(files);
}
