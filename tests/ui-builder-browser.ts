import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startTestPreview } from "./preview";
import { openAdmin } from "./browser-navigation";

const app = await startTestPreview();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1450, height: 1000 }, reducedMotion: "reduce" });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(app.url + "/admin");
  await page.getByRole("link", { name: "UI Builder", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "UI builder" }).waitFor();
  const preview = page.getByRole("region", { name: "Layout preview" });
  await preview.getByRole("heading", { name: "Understand your balances" }).waitFor();
  await preview.getByRole("heading", { name: "Compare balance definitions" }).waitFor();
  assert.equal(await preview.locator('[data-renderer="a2ui"]').count(), 1);
  assert.match(await preview.getByRole("heading", { name: "Understand your balances" }).evaluate((element) => getComputedStyle(element).fontFamily), /Georgia/);

  await page.getByLabel("Layout name").fill("Compare balances layout");
  await page.getByLabel("Description", { exact: true }).fill("Display the two balance definitions together.");
  await page.getByLabel("Heading", { exact: true }).fill("Read both balances");
  await preview.getByRole("heading", { name: "Read both balances" }).waitFor();
  await page.getByLabel("Component to add").selectOption("PznContentCard");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Move Information card up" }).click();
  await preview.getByRole("heading", { name: "Understanding your balances" }).waitFor();
  await page.getByRole("button", { name: "Remove Information card" }).click();
  await page.getByLabel("Intent or capability").selectOption("intent:show_balance");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await page.getByRole("button", { name: "Remove attachment Show balances", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByText("Draft saved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("Layout published.", { exact: true }).waitFor();
  await preview.getByRole("heading", { name: "Understanding your balances" }).waitFor({ state: "hidden" });

  const screenshots = process.env.PZN_TEST_SCREENSHOTS;
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: resolve(screenshots, "ui-builder-desktop.png"), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 850 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  if (screenshots) await page.screenshot({ path: resolve(screenshots, "ui-builder-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.setViewportSize({ width: 1450, height: 1000 });
  await page.getByRole("link", { name: "Open chat", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Your question" });
  await input.fill("Compare available and current balances.");
  await input.press("Enter");
  const published = page.locator(".published-ui[data-renderer='a2ui']");
  await published.getByRole("heading", { name: "Read both balances" }).waitFor();
  await published.getByRole("heading", { name: "Compare balance definitions" }).waitFor();
  await openAdmin(page, "inspector");
  const inspector = page.getByRole("region", { name: "Turn inspection details" });
  await inspector.getByRole("heading", { name: "Published UI" }).waitFor();
  await inspector.getByText("Compare balances layout", { exact: true }).waitFor();
  await openAdmin(page, "builder");
  await page.getByRole("tab", { name: /^Widget Studio & Library/ }).click();
  await page.getByLabel("Describe the widget you want to create").fill("Create a net worth KPI card showing $145,000 total assets, $22,000 cash reserve, and +6.4% YTD growth");
  await page.getByRole("button", { name: "Generate widget", exact: true }).click();
  await page.getByText("$145,000", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add to library", exact: true }).click();
  await page.getByRole("heading", { name: "Widget Library (4)", exact: true }).waitFor();
  if (screenshots) await page.screenshot({ path: resolve(screenshots, "widget-studio-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Use in layout", exact: true }).first().click();
  await page.getByRole("heading", { name: "Layout details", exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  console.log("UI builder preview, publishing, intent routing, Inspector, Widget Studio and responsive layout passed.");
} finally {
  await browser.close();
  await app.close();
}
