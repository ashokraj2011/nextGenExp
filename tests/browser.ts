import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startTestPreview } from "./preview";

const preview = await startTestPreview(undefined, ({ envelope }) => (
  envelope.request.toLowerCase().includes("slow") ? { delayMs: 4000 } : undefined
));
const executablePath = process.env.PZN_CHROME_PATH;
let browser;
try {
  browser = await chromium.launch(executablePath ? { executablePath } : existsSync(chromium.executablePath()) ? {} : { channel: "chrome" });
  const screenshots = resolve(process.env.PZN_TEST_SCREENSHOTS ?? "test-results");
  await mkdir(screenshots, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(12_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(preview.url + "/__test/a2ui");
  await page.getByText("A2UI integration smoke example", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Read demo guide" }).click();
  const smoke = JSON.parse(await page.getByTestId("a2ui-action").innerText());
  assert.equal(smoke.version, "1.0");
  assert.equal(smoke.action.name, "open_content");
  assert.equal(smoke.action.context.actionId, "smoke-issued-action-001");
  assert.equal(smoke.action.surfaceId, "integration-smoke-001");
  assert.equal(smoke.action.sourceComponentId, "open");
  await page.goto(preview.url);
  await page.getByText("Test mode", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "What would you like to explore?" }).waitFor();
  await page.screenshot({ path: resolve(screenshots, "welcome-desktop.png") });
  await page.getByRole("button", { name: /Compare two terms/ }).click();
  await page.getByRole("heading", { name: "Compare demo definitions" }).waitFor();
  await page.locator('[data-renderer="a2ui"]').waitFor();
  await page.getByText("Fictional demonstration only.", { exact: false }).waitFor();
  await page.screenshot({ path: resolve(screenshots, "comparison-desktop.png") });

  await page.getByText("View sources", { exact: true }).click();
  await page.getByText("Fictional PZN demo catalog · v1", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Helpful", exact: true }).click();
  await page.getByRole("button", { name: "Helpful", exact: true, pressed: true }).waitFor();
  await page.getByRole("button", { name: "Explain available balance", exact: true }).click();
  await page.getByRole("heading", { name: "Available balance: demo definition", exact: true, level: 3 }).waitFor();
  assert.equal(await page.locator('[data-renderer="a2ui"]').count(), 2);
  assert.equal(await page.getByRole("button", { name: "Explain available balance", exact: true }).isDisabled(), true);

  await page.reload();
  await page.getByRole("heading", { name: "Available balance: demo definition", exact: true, level: 3 }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Helpful", exact: true, pressed: true }).count(), 1);
  await page.getByRole("button", { name: "Open developer inspector" }).click();
  await page.getByRole("dialog", { name: "Developer inspector" }).waitFor();
  await page.getByText("Selected TS context", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Developer inspector" }).waitFor({ state: "hidden" });

  const input = page.getByLabel("Your question");
  await input.fill("Explain this slow balance request");
  await input.press("Shift+Enter");
  await input.press("End");
  assert.match(await input.inputValue(), /\n/);
  await input.press("Enter");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByText("Response stopped.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();

  const abortPattern = /\/api\/conversations\/[^/]+\/turns$/;
  await page.route(abortPattern, (route) => route.abort(), { times: 1 });
  await input.fill("Explain the fictional portfolio view.");
  await input.press("Enter");
  await page.getByText("Couldn’t reach the demo. Your draft is still here.", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "Explain the fictional portfolio view.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("heading", { name: "Understanding the fictional portfolio view" }).waitFor();

  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Guide me through a task/ }).click();
  await page.getByRole("heading", { name: "Fictional transfer checklist" }).waitFor();
  assert.deepEqual(await page.locator(".steps-list h4").allTextContents(), [
    "Read the demo overview", "Review synthetic details", "Stop at the preview",
  ]);
  await page.getByRole("button", { name: "Explain portfolio terms", exact: true }).click();
  await page.getByRole("heading", { name: "Understanding the fictional portfolio view" }).waitFor();

  await page.getByRole("link", { name: "Tool setup" }).click();
  await page.getByRole("heading", { name: "Tool setup", level: 1 }).waitFor();
  assert.equal(await page.getByRole("switch", { name: "Treatment Selector", exact: true }).isChecked(), true);
  await page.getByLabel("Response", { exact: true }).selectOption("ranked");
  await page.getByLabel("Add eligible content").selectOption("balance_available_definition");
  await page.getByLabel("Add eligible content").selectOption("balance_current_definition");
  await page.getByRole("button", { name: "Move balance_current_definition up", exact: true }).click();
  await page.getByRole("button", { name: "Run preview" }).click();
  await page.getByText("Ranked eligible content", { exact: true }).waitFor();
  assert.deepEqual(await page.getByRole("status").locator("ol code").allTextContents(), [
    "balance_current_definition", "balance_available_definition",
  ]);
  await page.screenshot({ path: resolve(screenshots, "tool-setup-desktop.png") });
  await page.getByLabel("Context", { exact: true }).selectOption("portsum");
  await page.getByLabel("Response", { exact: true }).selectOption("empty");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Tool settings saved.", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("list", { name: "Ranked content" }).waitFor();
  assert.equal(await page.getByLabel("Response", { exact: true }).inputValue(), "ranked");
  await page.getByLabel("Context", { exact: true }).selectOption("portsum");
  assert.equal(await page.getByLabel("Response", { exact: true }).inputValue(), "empty");
  await page.getByRole("link", { name: "Back to chat" }).click();
  await page.getByText("Test mode", { exact: true }).waitFor();
  const chatWithMock = page.getByLabel("Your question");
  await chatWithMock.fill("Explain the fictional portfolio view.");
  await chatWithMock.press("Enter");
  await page.getByText("There is no eligible demo content available for this request.", { exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);

  const mobile = await browser.newPage({ viewport: { width: 360, height: 780 }, isMobile: true, deviceScaleFactor: 1, reducedMotion: "reduce", hasTouch: true });
  mobile.setDefaultTimeout(12_000);
  await mobile.goto(preview.url);
  await mobile.getByText("Test mode", { exact: true }).waitFor();
  await mobile.getByRole("button", { name: "Show conversations" }).click();
  await mobile.getByRole("button", { name: "Close conversation navigation" }).click();
  await mobile.getByRole("button", { name: /Compare two terms/ }).click();
  await mobile.getByRole("heading", { name: "Compare demo definitions" }).waitFor();
  const columns = await mobile.locator(".compare-column").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().left));
  assert.equal(columns[0], columns[1]);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await mobile.getByLabel("Your question").isVisible(), true);
  const visibility = await mobile.getByRole("heading", { name: "Compare demo definitions" }).boundingBox();
  assert.ok(visibility && visibility.y >= 57, "The new mobile response starts in view");
  await mobile.screenshot({ path: resolve(screenshots, "comparison-mobile.png") });
  await mobile.getByRole("link", { name: "Tool setup" }).click();
  await mobile.getByRole("heading", { name: "Treatment Selector mock" }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.getByRole("button", { name: "Run preview" }).click();
  await mobile.getByText("Ranked eligible content", { exact: true }).waitFor();
  await mobile.screenshot({ path: resolve(screenshots, "tool-setup-mobile.png"), fullPage: true });
  const fallback = await browser.newPage();
  await fallback.route(/\/api\/turns\/turn_[a-f0-9]+$/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    if (payload.experience) payload.experience.messages[0].createSurface.catalogId = "invalid.catalog";
    await route.fulfill({ response, json: payload });
  });
  await fallback.goto(preview.url);
  await fallback.getByRole("button", { name: /Compare two terms/ }).click();
  await fallback.locator('[data-renderer="fallback"]').waitFor();
  await fallback.getByRole("heading", { name: "Compare demo definitions" }).waitFor();
  await fallback.getByText("Fictional demonstration only.", { exact: false }).waitFor();
  console.log("Browser checks passed for A2UI actions, comparison, sources, follow-up, refresh, inspector, stop, retry UI, draft retention, steps, 360 px layout, tool setup, and canonical renderer fallback.");
} finally {
  await browser?.close();
  await preview.close();
}
