// Isolated synthetic browser profiles only; never reads the owner's installed-app storage.
// Set PW_DIR to a scratch Playwright installation (the directory containing node_modules).
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(pathToFileURL(join(process.env.PW_DIR || "/tmp/pw", "node_modules/playwright/index.mjs")));
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const base = process.env.QA_URL || "http://127.0.0.1:4175";
const out = process.env.QA_OUT || "/tmp/fuel-qa";
await mkdir(out, { recursive: true });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 500, hasTouch: width < 500 });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(base, { waitUntil: "networkidle" });
    for (const [id, value] of [["ob-age", "30"], ["ob-ft", "5"], ["ob-in", "10"], ["ob-weight", "180"]]) await page.locator(`#${id}`).fill(value);
    await page.getByRole("button", { name: "Create my plan →" }).click();
    await page.locator("#splash").waitFor({ state: "hidden" });
    for (const tab of ["Plan", "Shop", "Today", "Meals", "Progress"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${tab} overflow at ${width}`);
      assert.ok((await page.locator(`#view-${tab.toLowerCase()}`).innerText()).length > 30);
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    assert.ok(await page.getByText("fuel-v15 ✓", { exact: true }).isVisible());
    await page.screenshot({ path: join(out, `settings-${width}.png`) });
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.screenshot({ path: join(out, `today-${width}.png`) });
    await page.getByRole("button", { name: "mark eaten", exact: true }).first().click();
    await page.reload({ waitUntil: "networkidle" });
    assert.ok(await page.getByRole("button", { name: "mark uneaten", exact: true }).first().isVisible());
    assert.deepEqual(errors, [], `browser errors at ${width}`);
    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    assert.ok((await page.locator("#view-plan").innerText()).length > 30, "offline plan is empty");
    console.log(`${width}px: five tabs + settings, persistence reload, and offline reload passed.`);
    await context.close();
  }
} finally { await browser.close(); }
