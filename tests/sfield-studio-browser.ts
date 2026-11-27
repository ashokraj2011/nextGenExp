import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { author as operatorCredentials } from "./operator-fixture";
import { startTestPreview } from "./preview";

const preview = await startTestPreview();
const executablePath = process.env.PZN_CHROME_PATH;
let browser;
try {
  browser = await chromium.launch(executablePath ? { executablePath } : existsSync(chromium.executablePath()) ? {} : { channel: "chrome" });
  const page = await browser.newPage({
    httpCredentials: { ...operatorCredentials, origin: preview.url },
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(12_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // 1. Navigate from CEP Admin Help to sfield Studio via the Admin sidebar link
  await page.goto(preview.url + "/admin/help");
  const studioLink = page.getByRole("link", { name: "sfield Studio", exact: true }).first();
  await studioLink.waitFor();
  await studioLink.click();
  await page.waitForURL("**/admin/sfield-studio");

  // 2. Verify Studio Workbench boots, health pill turns healthy, and Host Plugins render
  await page.getByText("sfield Studio · CEP", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Overview & Governance Locks", exact: true }).waitFor();
  await page.getByText("Self-Service PZN Studio", { exact: true }).waitFor();
  await page.getByText("Config Digest & Governance Lock", { exact: true }).waitFor();

  // 3. Switch to Tools & Playground tab and verify registered sfield tools load
  await page.getByRole("button", { name: /Tools & Playground/ }).click();
  await page.getByRole("heading", { name: "Tool Registry & Principal Playground", exact: true }).waitFor();
  await page.getByText("cep.empathy.assess@1.0.0", { exact: true }).first().waitFor();

  // 4. Switch to PII Firewall Lab and run a live scrub + rehydrate check
  await page.getByRole("button", { name: /PII Firewall Lab/ }).click();
  await page.getByRole("heading", { name: "PII Firewall Lab", exact: true }).waitFor();
  await page.getByRole("button", { name: "Scrub & Rehydrate", exact: true }).click();
  await page.getByText(/Scrubbed Egress \(\d+ redactions\)/).waitFor();
  await page.getByText("[PII_SSN_1]").first().waitFor();

  await page.getByRole("button", { name: "Overview & Locks", exact: true }).click();
  await page.getByRole("button", { name: "Request lock approval", exact: true }).click();
  await page.getByRole("link", { name: "Review in Admin chat", exact: true }).click();
  await page.getByRole("button", { name: "Approve publication", exact: true }).click();
  await page.getByText("Approved & Executed", { exact: true }).waitFor();
  const studio = await page.request.get(preview.url + "/admin/sfield-studio/api/overview");
  assert.equal((await studio.json()).lock.approved, true);

  // 5. Verify standalone /sfield-sdk.html guide links cleanly to sfield Studio
  await page.goto(preview.url + "/sfield-sdk.html");
  await page.getByRole("link", { name: "Open sfield Studio", exact: true }).waitFor();

  assert.deepEqual(pageErrors, [], "Expected zero browser page errors in sfield Studio");
  console.log("sfield Studio browser verification passed (Admin Nav -> Overview -> Tools & Playground -> PII Lab -> SDK HTML guide).");
} finally {
  await browser?.close();
  await preview.close();
}
