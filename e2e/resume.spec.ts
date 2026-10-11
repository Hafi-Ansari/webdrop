import { expect, test } from "@playwright/test";
import { makeFile, openDevice, sendTo, sha256 } from "./helpers.ts";

test("a transfer resumes where it left off after the connection drops", async ({ browser }, info) => {
  const alice = await openDevice(browser);
  const bob = await openDevice(browser);
  try {
    const path = info.outputPath("big.bin");
    const size = 64 * 1024 * 1024;
    const digest = await makeFile(path, size);

    // Record every state the sender's transfer goes through.
    await alice.page.evaluate(() => {
      const w = window as any;
      w.__states = [];
      setInterval(() => {
        for (const t of w.__webdrop.controller.transfers.outgoing.values()) {
          if (w.__states.at(-1) !== t.state) w.__states.push(t.state);
        }
      }, 1);
    });

    await sendTo(alice.page, bob.name, path);
    const download = bob.page.waitForEvent("download", { timeout: 60_000 });
    await bob.page.getByTestId("accept").click();

    // Kill the peer connection once a few MB have been written.
    const droppedAt = await bob.page.evaluate(async () => {
      const c = (window as any).__webdrop.controller;
      for (;;) {
        const t = [...c.transfers.incoming.values()][0];
        if (t && t.bytes > 8 * 1024 * 1024) {
          for (const s of c.sessions.values()) s.close("test: simulated drop");
          return t.bytes as number;
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    });
    expect(droppedAt).toBeLessThan(size);

    const file = await download;
    expect(await sha256((await file.path())!)).toBe(digest);
    await expect(alice.page.getByTestId("transfer")).toHaveAttribute("data-state", "done");
    const states: string[] = await alice.page.evaluate(() => (window as any).__states);
    expect(states).toContain("interrupted");
    expect(states.at(-1)).toBe("done");
  } finally {
    await alice.close();
    await bob.close();
  }
});
