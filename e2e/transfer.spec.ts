import { expect, test } from "@playwright/test";
import { cspViolations, makeFile, openDevice, peerCard, sendTo, sha256 } from "./helpers.ts";

test("devices on the same network discover each other and transfer a file end to end", async ({ browser }, info) => {
  const alice = await openDevice(browser);
  const bob = await openDevice(browser);
  try {
    await expect(peerCard(alice.page, bob.name)).toBeVisible();
    await expect(peerCard(bob.page, alice.name)).toBeVisible();

    const path = info.outputPath("hello.bin");
    const digest = await makeFile(path, 5 * 1024 * 1024 + 123);
    await sendTo(alice.page, bob.name, path);

    const dialog = bob.page.getByTestId("incoming-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(alice.name);
    await expect(bob.page.getByTestId("incoming-file")).toHaveText("hello.bin");
    const code = (await bob.page.getByTestId("incoming-sas").textContent())!.trim();
    expect(code).toMatch(/^\d{3} \d{3}$/);
    // The sender sees the same verification code while waiting.
    await expect(alice.page.getByTestId("transfer-status")).toContainText(`code ${code}`);

    const download = bob.page.waitForEvent("download");
    await bob.page.getByTestId("accept").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("hello.bin");
    expect(await sha256((await file.path())!)).toBe(digest);

    await expect(alice.page.getByTestId("transfer")).toHaveAttribute("data-state", "done");
    await expect(bob.page.getByTestId("transfer")).toHaveAttribute("data-state", "done");
    expect(await cspViolations(alice.page)).toEqual([]);
    expect(await cspViolations(bob.page)).toEqual([]);
  } finally {
    await alice.close();
    await bob.close();
  }
});

test("the receiver can decline, and nothing is saved", async ({ browser }, info) => {
  const alice = await openDevice(browser);
  const bob = await openDevice(browser);
  try {
    const path = info.outputPath("nope.txt");
    await makeFile(path, 1000);
    await sendTo(alice.page, bob.name, path);
    await expect(bob.page.getByTestId("incoming-dialog")).toBeVisible();
    let downloaded = false;
    bob.page.on("download", () => (downloaded = true));
    await bob.page.getByRole("button", { name: "Decline" }).click();
    await expect(alice.page.getByTestId("transfer")).toHaveAttribute("data-state", "declined");
    await expect(bob.page.getByTestId("incoming-dialog")).toBeHidden();
    expect(downloaded).toBe(false);
  } finally {
    await alice.close();
    await bob.close();
  }
});

test("sends several files in one go", async ({ browser }, info) => {
  const alice = await openDevice(browser);
  const bob = await openDevice(browser);
  try {
    const paths = [info.outputPath("one.bin"), info.outputPath("two.bin"), info.outputPath("empty.bin")];
    const digests = [await makeFile(paths[0]!, 300_000), await makeFile(paths[1]!, 2_000_000), await makeFile(paths[2]!, 0)];
    await sendTo(alice.page, bob.name, paths);
    await expect(bob.page.getByTestId("incoming-file")).toHaveCount(3);
    // Files are saved in order, but the browser can report their downloads out of order: match by name.
    const downloads: Promise<[string, string]>[] = [];
    bob.page.on("download", (d) => downloads.push(d.path().then(async (p) => [d.suggestedFilename(), await sha256(p!)])));
    await bob.page.getByTestId("accept").click();
    await expect(bob.page.getByTestId("transfer")).toHaveAttribute("data-state", "done");
    await expect.poll(() => downloads.length).toBe(3);
    expect(Object.fromEntries(await Promise.all(downloads))).toEqual({
      "one.bin": digests[0],
      "two.bin": digests[1],
      "empty.bin": digests[2],
    });
  } finally {
    await alice.close();
    await bob.close();
  }
});
