import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startTestPreview } from "./preview";

const app = await startTestPreview();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  await page.goto(app.url + "/chat");
  const question = page.getByRole("textbox", { name: "Your question" });
  await question.fill("I want to buy a house in two years. Show me how close I am and help me explore a savings plan.");
  await question.press("Enter");
  const latest = () => page.locator('[data-renderer="a2ui"]').last();
  await latest().getByRole("region", { name: "Projected savings", exact: true }).getByText("$50,000", { exact: false }).first().waitFor();
  await latest().getByRole("slider", { name: "Monthly contribution" }).press("End");
  await latest().getByRole("button", { name: "Recalculate", exact: true }).click();
  await latest().getByRole("region", { name: "Projected savings", exact: true }).getByText("$146,000", { exact: false }).first().waitFor();
  assert.equal(await page.locator('[data-renderer="fallback"]').count(), 0);
  await latest().getByRole("button", { name: "Save savings plan", exact: true }).click();
  await latest().getByText("Your savings plan was saved.", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Open developer inspector" }).click();
  const dialog = page.getByRole("dialog", { name: "Developer inspector" });
  await dialog.getByRole("heading", { name: "Experience decision trace" }).waitFor();
  await dialog.getByText("Verified Experience IR", { exact: true }).click();
  assert.match(await dialog.locator('pre[aria-label="Verified Experience IR"]').innerText(), /evidenceId/);
  await dialog.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "Open call logs" }).click();
  const logs = page.getByRole("dialog", { name: "Call logs" });
  await logs.getByText("Experience Agent and tools").waitFor();
  await logs.getByText("savings.projection.calculate@1.0.0 · succeeded", { exact: true }).click();
  await logs.getByText("savings.projection.calculate@1.0.0 tool response", { exact: true }).waitFor();
  await logs.getByRole("button", { name: "Close call logs" }).click();

  await page.setViewportSize({ width: 390, height: 840 });
  assert.ok(await latest().getByRole("img", { name: /Projected savings rise/ }).isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.getByRole("link", { name: "Tool setup" }).click();
  await page.getByRole("heading", { name: "Capability Studio" }).waitFor();
  await page.getByText("Evaluation", { exact: true }).click();
  await page.getByRole("table", { name: "Test mode results" }).getByRole("rowheader", { name: "Multi-step" }).waitFor();
  await page.getByLabel("Published capability").selectOption("goal.savings.required-contribution@1.0.0");
  await page.getByRole("button", { name: "Validate manifest", exact: true }).click();
  await page.getByText("Manifest is valid.", { exact: true }).waitFor();
  await page.getByLabel("Preview request").fill("How much do I need to save each month to reach my house deposit target?");
  await page.getByRole("button", { name: "Run capability in chat", exact: true }).click();
  await latest().getByRole("heading", { name: "Required monthly savings", exact: true }).waitFor();
  console.log("Agentic chat, A2UI revisions, Inspector, Logs and Capability Studio passed.");
} finally {
  await browser.close();
  await app.close();
}
