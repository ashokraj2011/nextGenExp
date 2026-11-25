import { author as operatorCredentials, reviewer } from "./operator-fixture";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startTestPreview } from "./preview";
import { openAdmin } from "./browser-navigation";

const app = await startTestPreview();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ httpCredentials: { ...operatorCredentials, origin: app.url }, viewport: { width: 1450, height: 1000 }, reducedMotion: "reduce" });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(app.url + "/admin");
  await page.getByRole("link", { name: "UI Builder", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "UI Studio" }).waitFor();
  const preview = page.getByRole("region", { name: "Layout preview" });
  await preview.getByRole("heading", { name: "Understand your balances" }).waitFor();
  await preview.getByRole("heading", { name: "Compare balance definitions" }).waitFor();
  assert.equal(await preview.locator('[data-renderer="a2ui"]').count(), 1);
  assert.match(await preview.getByRole("heading", { name: "Understand your balances" }).evaluate((element) => getComputedStyle(element).fontFamily), /Georgia/);

  await page.getByLabel("Layout name").fill("Compare balances layout");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByLabel("When should this layout appear?", { exact: true }).fill("Display the two balance definitions together.");
  await page.getByRole("button", { name: /^Understand your balances/ }).click();
  await page.getByLabel("Heading", { exact: true }).fill("Read both balances");
  await preview.getByRole("heading", { name: "Read both balances" }).waitFor();
  await page.getByRole("button", { name: "Add block", exact: true }).click();
  await page.getByRole("menu").getByRole("button", { name: "Information card", exact: true }).click();
  await page.getByRole("button", { name: "Move Information card up" }).click();
  await preview.getByRole("heading", { name: "Understanding your balances" }).waitFor();
  await page.getByRole("button", { name: "Remove Information card" }).click();
  await page.getByLabel("Attach intent or capability").selectOption("intent:show_balance");
  await page.getByRole("button", { name: "Remove Show balances", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByText("Draft saved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("Published to the shared design library.", { exact: true }).waitFor();
  await preview.getByRole("heading", { name: "Understanding your balances" }).waitFor({ state: "hidden" });

  const colleague = await browser.newPage({ httpCredentials: { ...reviewer, origin: app.url } });
  await colleague.goto(app.url + "/admin/ui");
  await colleague.getByRole("button", { name: "Design library", exact: true }).click();
  const library = colleague.getByRole("region", { name: "Shared design library" });
  await library.getByRole("heading", { name: "Compare balances layout" }).waitFor();
  assert.equal(await library.getByRole("button", { name: "Edit my design" }).count(), 0);
  await library.getByRole("button", { name: "Use as template" }).click();
  assert.equal(await colleague.getByLabel("Layout name").inputValue(), "Compare balances layout copy");
  assert.equal(await colleague.getByRole("button", { name: "Publish", exact: true }).isDisabled(), true);
  await colleague.close();

  const customer = await browser.newPage();
  await customer.goto(app.url + "/login");
  await customer.getByRole("button", { name: "Sign in as Jordan Lee", exact: true }).click();
  const customerInput = customer.getByRole("textbox", { name: "Your question" });
  await customerInput.fill("Compare available and current balances.");
  await customerInput.press("Enter");
  await customer.getByRole("heading", { name: "Read both balances", exact: true }).waitFor();
  await customer.close();

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
  await page.getByRole("button", { name: /^Widget Library/ }).click();
  await page.getByLabel("Describe the widget or paste a screenshot").fill("Create a net worth KPI card showing $145,000 total assets, $22,000 cash reserve, and +6.4% YTD growth");
  await page.getByRole("button", { name: "Generate widget", exact: true }).click();
  await page.getByText("$145,000", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add to library", exact: true }).click();
  await page.getByRole("heading", { name: "Widget Library (4)", exact: true }).waitFor();
  if (screenshots) await page.screenshot({ path: resolve(screenshots, "widget-studio-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Use in layout", exact: true }).first().click();
  await page.getByRole("region", { name: "Layout blocks and settings", exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  console.log("UI builder preview, publishing, intent routing, Inspector, Widget Studio and responsive layout passed.");
} finally {
  await browser.close();
  await app.close();
}
