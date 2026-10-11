import { expect, test } from "@playwright/test";
import { makeFile, openDevice, peerCard, sendTo, sha256 } from "./helpers.ts";

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

test("a signaling reconnect does not disturb a running transfer", async ({ browser }, info) => {
  const alice = await openDevice(browser);
  const bob = await openDevice(browser);
  try {
    const path = info.outputPath("steady.bin");
    const digest = await makeFile(path, 48 * 1024 * 1024);
    await sendTo(alice.page, bob.name, path);
    const download = bob.page.waitForEvent("download", { timeout: 60_000 });
    await bob.page.getByTestId("accept").click();

    await bob.page.waitForFunction(() => {
      const t = [...(window as any).__webdrop.controller.transfers.incoming.values()][0];
      return t && t.bytes > 4 * 1024 * 1024;
    });
    // Drop both WebSockets; the P2P link is independent and identities resume.
    for (const d of [alice, bob]) await d.page.evaluate(() => (window as any).__webdrop.controller.signaling.ws.close());
    await expect(alice.page.getByTestId("connection")).toHaveAttribute("data-state", "open");

    expect(await sha256((await (await download).path())!)).toBe(digest);
    await expect(alice.page.getByTestId("transfer")).toHaveAttribute("data-state", "done");
    // Same names after the reconnect: identities were resumed, not replaced.
    await expect(alice.page.getByTestId("self-name")).toHaveText(alice.name);
  } finally {
    await alice.close();
    await bob.close();
  }
});

test("a reload keeps the same identity and a device that leaves disappears at once", async ({ browser }) => {
  const alice = await openDevice(browser);
  const bob = await openDevice(browser);
  try {
    await expect(peerCard(alice.page, bob.name)).toBeVisible();

    await bob.page.reload();
    await expect(bob.page.getByTestId("connection")).toHaveAttribute("data-state", "open");
    await expect(bob.page.getByTestId("self-name")).toHaveText(bob.name);
    await expect(peerCard(alice.page, bob.name)).toHaveCount(1);

    // Well under the server's 15 s resume grace period.
    await bob.page.goto("about:blank");
    await expect(peerCard(alice.page, bob.name)).toHaveCount(0, { timeout: 5000 });
  } finally {
    await alice.close();
    await bob.close();
  }
});
