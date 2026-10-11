import { chromium, expect, firefox, test, webkit, type Browser } from "@playwright/test";
import { cspViolations, makeFile, openDevice, peerCard, sendTo, sha256 } from "./helpers.ts";

// Real host candidates instead of mDNS names, so headless browsers on one machine can connect.
const launchers: Record<string, () => Promise<Browser>> = {
  chromium: () => chromium.launch({ args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] }),
  firefox: () => firefox.launch({ firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false } }),
  webkit: () => webkit.launch(),
};


const pairs: Array<[string, string]> = [
  ["chromium", "firefox"],
  ["firefox", "chromium"],
  ["chromium", "webkit"],
  ["webkit", "firefox"],
];

for (const [from, to] of pairs) {
  test(`interop: ${from} sends to ${to}`, async ({ baseURL }, info) => {
    test.skip(info.project.name !== "chromium", "launches its own browsers");
    let a: Browser | undefined;
    let b: Browser | undefined;
    try {
      a = await launchers[from]!();
      b = await launchers[to]!();
    } catch (err) {
      test.skip(true, `browser unavailable: ${String(err).split("\n")[0]}`);
    }
    try {
      const alice = await openDevice(a!, baseURL);
      const bob = await openDevice(b!, baseURL);
      await expect(peerCard(alice.page, bob.name)).toBeVisible();

      const path = info.outputPath("interop.bin");
      const digest = await makeFile(path, 3 * 1024 * 1024 + 7);
      await sendTo(alice.page, bob.name, path);
      await expect(bob.page.getByTestId("incoming-dialog")).toBeVisible({ timeout: 20_000 });
      const code = (await bob.page.getByTestId("incoming-sas").textContent())!.trim();
      await expect(alice.page.getByTestId("transfer-status")).toContainText(code);

      const download = bob.page.waitForEvent("download");
      await bob.page.getByTestId("accept").click();
      expect(await sha256((await (await download).path())!)).toBe(digest);
      await expect(alice.page.getByTestId("transfer")).toHaveAttribute("data-state", "done");
      expect(await cspViolations(alice.page)).toEqual([]);
      expect(await cspViolations(bob.page)).toEqual([]);
    } finally {
      await a?.close();
      await b?.close();
    }
  });
}
