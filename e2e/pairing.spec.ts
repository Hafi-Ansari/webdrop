import { expect, test } from "@playwright/test";
import { openDevice, peerCard } from "./helpers.ts";

test("devices pair with a code, and a #pair= link joins automatically", async ({ browser, baseURL }) => {
  const alice = await openDevice(browser);
  const bob = await openDevice(browser);
  try {
    await alice.page.getByTestId("pair-open").click();
    await alice.page.getByTestId("pair-create").click();
    const code = (await alice.page.getByTestId("pair-code").textContent())!.trim();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    await expect(alice.page.getByRole("img", { name: /QR code/ })).toBeVisible();

    await bob.page.getByTestId("pair-open").click();
    // Lowercase and look-alike letters are normalized.
    await bob.page.getByTestId("pair-input").fill(code.toLowerCase());
    await bob.page.getByTestId("pair-join").click();
    await expect(peerCard(bob.page, alice.name)).toContainText("Paired");
    await expect(peerCard(alice.page, bob.name)).toContainText("Paired");

    // A third device follows the QR link.
    const carol = await openDevice(browser);
    await carol.page.goto(`${baseURL}/#pair=${code}`);
    await expect(peerCard(carol.page, alice.name)).toContainText("Paired");
    expect(new URL(carol.page.url()).hash).toBe("");
    await carol.close();

    // Unknown codes produce a friendly error.
    await bob.page.getByTestId("pair-input").fill("ZZZZZZ");
    await bob.page.getByTestId("pair-join").click();
    await expect(bob.page.getByRole("status")).toContainText("No device is using that code");
  } finally {
    await alice.close();
    await bob.close();
  }
});
