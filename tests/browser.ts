import { author as operatorCredentials } from "./operator-fixture";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { chromium, type Locator } from "playwright";
import marcusCalls from "../fixtures/marcus-sfield-exchanges.json";
import type { TreatmentRun, TurnPayloads } from "../packages/contracts/inspector";
import { defaultToolSetup } from "../packages/contracts/tool-setup";
import { defaultFundingWorkflow, fundingToolRef } from "../packages/contracts/funding-workflow";
import { beneficiaryReviewWorkflow } from "../packages/contracts/customer-workflows";
import { activeContextCatalog, FixtureTsAdapter, tsFixtures } from "../packages/ts-adapter";
import { adminPaths } from "../packages/contracts/admin-paths";
import { pendingActionsContext } from "../packages/contracts/workspace";
import { openAdmin, openCustomerChat } from "./browser-navigation";
import { startTestPreview } from "./preview";

async function assertArchitectureLabelsFit(map: Locator) {
  const overflow = await map.locator(".sa-node").evaluateAll((nodes) => nodes.flatMap((node) => {
    const box = node.querySelector<SVGRectElement>(".sa-box")!.getBBox();
    return [...node.querySelectorAll<SVGTextElement>("text")].filter((text) => {
      const bounds = text.getBBox();
      return bounds.x < 0 || bounds.x + bounds.width > box.width - 3 || bounds.y + bounds.height > box.height;
    }).map((text) => text.textContent);
  }));
  assert.deepEqual(overflow, [], "All component labels fit within their boxes");
}

async function readExchange(drawer: Locator) {
  return {
    request: JSON.parse(await drawer.getByLabel("Request JSON", { exact: true }).innerText()),
    response: JSON.parse(await drawer.getByLabel("Response JSON", { exact: true }).innerText()),
  };
}

const preview = await startTestPreview(undefined, ({ envelope }) => (
  envelope.request.toLowerCase().includes("slow") ? { delayMs: 4000 }
    : envelope.inputType === "PznContextRoutingInput" && envelope.request === "Let me know my portfolio summary." ? { delayMs: 600 } : undefined
));
const executablePath = process.env.PZN_CHROME_PATH;
let browser;
try {
  browser = await chromium.launch(executablePath ? { executablePath } : existsSync(chromium.executablePath()) ? {} : { channel: "chrome" });
  const screenshots = resolve(process.env.PZN_TEST_SCREENSHOTS ?? "test-results");
  await mkdir(screenshots, { recursive: true });
  const page = await browser.newPage({ httpCredentials: { ...operatorCredentials, origin: preview.url }, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(12_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const renderer = await createViteServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  try {
    await renderer.listen();
    const probe = new URL("renderer-probe.html", renderer.resolvedUrls!.local[0]).href;
    await page.route(probe, (route) => route.fulfill({ contentType: "text/html",
      body: '<div id="root"></div><script type="module" src="/tests/renderer-probe.tsx"></script>' }));
    await page.goto(probe);
    await page.getByText("A2UI integration smoke example", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Read demo guide" }).click();
    const smoke = JSON.parse(await page.getByTestId("a2ui-action").innerText());
    assert.equal(smoke.version, "1.0");
    assert.equal(smoke.action.name, "open_content");
    assert.equal(smoke.action.context.actionId, "smoke-issued-action-001");
    assert.equal(smoke.action.surfaceId, "integration-smoke-001");
    assert.equal(smoke.action.sourceComponentId, "open");
  } finally { await renderer.close(); }
  await page.goto(preview.url + "/planning");
  await page.getByRole("heading", { name: "Plan for what’s next.", level: 1 }).waitFor();
  const heroPhoto = page.getByRole("img", { name: "Two women walking together along a coastal path", exact: true });
  assert.equal(await heroPhoto.evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    return new URL(image.currentSrc).origin === location.origin;
  }), true);
  await page.getByRole("link", { name: "Start a conversation", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome, Alice.", exact: true }).waitFor();
  await page.getByRole("link", { name: "Wealth Advisory", exact: true }).click();
  assert.equal(new URL(page.url()).pathname, "/wealth");
  await openAdmin(page, "help");
  await page.getByRole("heading", { name: "How CEP & sfield work", exact: true, level: 1 }).waitFor();
  await page.getByRole("navigation", { name: "Help sections" }).getByRole("link", { name: "Developer docs" }).click();
  await page.getByRole("heading", { name: "Run the app and trace a chat turn" }).waitFor();
  const guides = page.getByRole("navigation", { name: "Developer guides" });
  await guides.getByRole("link", { name: "Create a chat UI" }).click();
  await page.getByRole("heading", { name: "Preview a design through the API" }).waitFor();
  assert.match(await page.locator(".developer-prose pre").innerText(), /\/api\/admin\/ui-layout-preview/);
  await guides.getByRole("link", { name: "sfield and tools" }).click();
  const example = page.getByRole("link", { name: "Download tool example" });
  const downloadEvent = page.waitForEvent("download");
  await example.click();
  const toolDownload = await downloadEvent;
  assert.equal(toolDownload.suggestedFilename(), "read-tool.mjs");
  assert.deepEqual(await readFile((await toolDownload.path())!), await readFile("docs/developers/examples/read-tool.mjs"));
  await guides.getByRole("link", { name: "Rules and workflows" }).click();
  await page.reload();
  await page.getByRole("heading", { name: "Read the TS decision" }).waitFor();
  assert.equal(await guides.getByRole("link", { name: "Rules and workflows" }).getAttribute("aria-current"), "page");
  const fundingExample = new FixtureTsAdapter({ scenarioId: "normal", ordinal: 1 });
  const marcusDecision = await fundingExample.selectEligibleContent({ mid: "DEMO-MID-1003", context: "address-update" });
  const documentedDecision = page.getByRole("article", { name: "Rules and workflows" }).locator("code.language-json").first();
  assert.deepEqual(JSON.parse(await documentedDecision.innerText()), marcusDecision.decision);
  await openAdmin(page, "help");
  const journeyMap = page.getByRole("region", { name: "Customer interaction map", exact: true });
  const journeyNav = journeyMap.getByRole("navigation", { name: "Customer journey stages" });
  for (const label of ["Sign in", "Find the intent", "Check eligibility", "Build the reply", "Follow up", "Return later"]) {
    const stage = journeyNav.getByRole("link", { name: new RegExp(label, "i") });
    await stage.click();
    await journeyMap.getByRole("table", { name: "Exchanges for " + label, exact: true }).waitFor();
    assert.equal(await stage.getAttribute("aria-current"), "step");
  }
  await journeyMap.getByRole("link", { name: "building the UI", exact: true }).click();
  await page.reload();
  await journeyMap.getByRole("table", { name: "Exchanges for Build the reply" }).getByText(/assembled by server code/).waitFor();
  assert.equal(new URL(page.url()).hash, "#interaction-render");
  await page.goBack();
  await journeyMap.getByRole("table", { name: "Exchanges for Return later" }).waitFor();
  const systemMap = page.getByRole("region", { name: "System architecture", exact: true });
  await page.getByRole("link", { name: "System architecture", exact: true }).click();
  assert.equal(new URL(page.url()).hash, "#system-architecture");
  const componentDetails = systemMap.getByRole("region", { name: "Selected architecture component" });
  const nodes = systemMap.locator("svg.sa-canvas .sa-node");
  assert.equal(await nodes.count(), 10);
  for (const node of await nodes.all()) {
    await node.focus();
    await node.press("Enter");
    await componentDetails.getByRole("heading", { name: (await node.getAttribute("aria-label"))!, exact: true }).waitFor();
  }
  await systemMap.getByRole("button", { name: "Treatment Selector", exact: true }).click();
  await componentDetails.getByText(/legacy contract returns ranked content IDs/).waitFor();
  await componentDetails.getByRole("link", { name: /contract/i }).click();
  assert.equal(new URL(page.url()).hash, "#contracts");
  await page.getByRole("button", { name: "Download treatment-selector.tool.json", exact: true }).waitFor();
  await page.getByRole("link", { name: "System architecture", exact: true }).click();
  await systemMap.getByRole("button", { name: "sfield runtime", exact: true }).click();
  await assertArchitectureLabelsFit(systemMap);
  await systemMap.screenshot({ path: resolve(screenshots, "chat-system-architecture.png") });
  await systemMap.getByRole("button", { name: "After a funding click", exact: true }).click();
  assert.equal(await systemMap.locator('.sa-node[data-earlier="true"]').count(), 2);
  await assertArchitectureLabelsFit(systemMap);
  const exporting = page.waitForEvent("download");
  await systemMap.getByRole("button", { name: "Download SVG" }).click();
  const exportedMap = await exporting;
  assert.equal(exportedMap.suggestedFilename(), "funding-workflow-architecture.svg");
  const vector = await readFile(await exportedMap.path(), "utf8");
  assert.match(vector, /Ordered funding workflow architecture/);
  assert.match(vector, /sfield.sqlite/);
  assert.equal(await page.evaluate((xml) => {
    const drawing = new DOMParser().parseFromString(xml, "image/svg+xml");
    return drawing.querySelectorAll(".sa-number").length === 11 && !drawing.querySelector('[role="button"]');
  }, vector), true);
  assert.equal(await page.evaluate((xml) => new DOMParser().parseFromString(xml, "image/svg+xml").querySelector("parsererror") === null, vector), true);
  await systemMap.getByRole("button", { name: "Chat message", exact: true }).click();
  const architecture = page.getByRole("region", { name: "How chat answers a message", exact: true });
  await architecture.getByRole("heading", { name: "CEP app server", exact: true }).waitFor();
  await architecture.getByRole("heading", { name: "sfield", exact: true }).waitFor();
  const sequence = page.getByRole("list", { name: "Chat interaction sequence" });
  await sequence.getByText("Eligible content, standalone action and workflow", { exact: true }).waitFor();
  await sequence.getByText("Build the A2UI surface", { exact: true }).waitFor();
  await sequence.getByText("Send the finished surface to chat", { exact: true }).waitFor();
  const numberedSteps = await sequence.getByRole("button", { name: /^Step \d+ ·/ }).all();
  assert.equal(numberedSteps.length, 17);
  const exchanges = [];
  const exchangePaths = [];
  for (const [index, button] of numberedSteps.entries()) {
    await button.click();
    const drawer = page.getByRole("dialog", { name: new RegExp(`^Step ${index + 1} ·`) });
    await drawer.getByText("Marcus Reed", { exact: true }).waitFor();
    exchanges.push(await readExchange(drawer));
    exchangePaths.push(await drawer.locator(".help-exchange-direction strong").allTextContents());
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
  }
  assert.deepEqual(exchangePaths[1], ["CEP app server", "CEP app server"]);
  assert.deepEqual(exchangePaths[2], ["CEP app server", "Language model"]);
  assert.deepEqual(exchangePaths[3], ["Language model", "CEP app server"]);
  assert.deepEqual(exchanges[1].request, { tenantId: "pzn-local", domainId: "wealth", audience: "customer" });
  assert.deepEqual(exchanges[1].response, ["verified_experience", "stock_holdings", "stock_trade", "custom_dynamic_ui"]);
  assert.deepEqual(exchanges[2].request.flows.map((flow: { id: string }) => flow.id), exchanges[1].response);
  assert.equal(exchanges[3].response.capabilityId, "verified_experience");
  assert.deepEqual(exchangePaths[6], ["CEP app server", "sfield", "Language model"]);
  assert.deepEqual(exchangePaths[8], ["CEP app server", "sfield", "Treatment Selector"]);
  assert.deepEqual(exchangePaths[9], ["Treatment Selector", "sfield", "CEP app server"]);
  assert.deepEqual(exchangePaths[12], ["CEP app server", "sfield", "Language model"]);
  assert.deepEqual(exchangePaths[14], ["CEP app server", "CEP app server"]);
  assert.equal(exchanges[0].request.message, "I moved and need to update my address.");
  const topicScores = marcusCalls.scores.response.output;
  assert.deepEqual(exchanges[5].response.propensity, topicScores);
  assert.deepEqual(exchanges[6].request.catalog, activeContextCatalog);
  assert.equal(exchanges[6].request.customerContext.fundingStatus, "unfunded");
  assert.equal(exchanges[7].response.intentId, "update_address");
  assert.deepEqual(exchanges[8], exchanges[9]);
  assert.deepEqual(exchanges[9].request.adapterInput, { mid: "DEMO-MID-1003", context: "address-update" });
  assert.deepEqual(exchanges[9].response, marcusCalls.treatment.response.output);
  assert.equal(exchanges[11].response.candidates[1].contentId, "fund_account");
  assert.equal(exchanges[13].response.blocks[0].component, "PznStepList");
  assert.equal(exchanges[14].response.a2uiProtocol, "v1.0");
  assert.equal(exchanges[15].response.type, "experience.ready");
  assert.equal(exchanges[15].response.actionMode, "verified_experience");
  assert.equal(exchanges[16].request.envelope.action.name, "request_follow_up");
  assert.equal(exchanges[16].response.turn.message, "Preview funding");

  const handoffs = sequence.getByRole("button", { name: /^App server to sfield handoff · step / });
  assert.equal(await handoffs.count(), 3);
  for (const [number, call] of [[7, "router"], [9, "treatment"], [13, "composer"]] as const) {
    const button = sequence.getByRole("button", { name: `App server to sfield handoff · step ${number}`, exact: true });
    await button.click();
    const drawer = page.getByRole("dialog", { name: `Step ${number} · App server to sfield`, exact: true });
    assert.deepEqual(await drawer.locator(".help-exchange-direction strong").allTextContents(), ["CEP app server", "sfield"]);
    if (call !== "router") {
      assert.deepEqual(await readExchange(drawer), marcusCalls[call]);
    }
    if (call === "router" || call === "composer") {
      await drawer.getByText("Read the model input as JSON", { exact: true }).click();
      const modelInput = JSON.parse(await drawer.getByLabel("Model input JSON", { exact: true }).innerText());
      assert.deepEqual(modelInput, exchanges[number - 1].request);
    }
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    assert.equal(await button.evaluate((element) => element === document.activeElement), true);
  }
  await page.getByRole("link", { name: "sfield", exact: true }).click();
  assert.equal(new URL(page.url()).hash, "#sfield");
  const toolRegistry = page.getByRole("list", { name: "sfield tool registry", exact: true });
  await toolRegistry.getByRole("link", { name: "Retirement accounts", exact: true }).click();
  await page.getByRole("button", { name: "Download retirement-accounts.tool.json", exact: true }).waitFor();
  await toolRegistry.getByText("Experience Composer", { exact: true }).waitFor();
  await toolRegistry.getByRole("link", { name: "Topic relevance scores", exact: true }).click();
  await page.getByRole("button", { name: "propensity.json", exact: true }).click();
  await page.getByRole("button", { name: "Download propensity.json", exact: true }).waitFor();
  await toolRegistry.getByRole("link", { name: "Portfolio Snapshot", exact: true }).click();
  assert.equal(new URL(page.url()).hash, "#contracts");
  await page.getByRole("button", { name: "Download portfolio-snapshot.tool.json", exact: true }).waitFor();
  await page.getByRole("link", { name: "Treatment Selector’s role", exact: true }).click();
  assert.equal(new URL(page.url()).hash, "#proposal");
  const proposal = page.getByRole("region", { name: "Expanding Treatment Selector from Content Recommendations to Actions and Workflows" });
  assert.equal(await proposal.getByRole("link", { name: "View Pending actions in Logs" }).getAttribute("href"), "/admin/logs?source=pending-actions");
  const diagram = proposal.getByRole("figure", { name: "How TS and sfield work together" });
  await diagram.getByText(/No Marcus address-update run is available/).waitFor();
  assert.equal(await diagram.getByRole("button", { name: /^Step \d+ ·/ }).count(), 5);
  await diagram.getByRole("button", { name: /^Step 3 ·/ }).click();
  await page.getByRole("dialog").getByText(/No Marcus address-update run is available/).waitFor();
  await page.keyboard.press("Escape");
  const diagramLink = await proposal.getByRole("link", { name: "Download diagram" }).getAttribute("href");
  assert.ok(diagramLink && (await page.request.get(new URL(diagramLink, preview.url).href)).ok());
  await proposal.getByText("Compare the legacy and current TS responses", { exact: true }).click();
  const legacyJson = proposal.getByLabel("Content IDs JSON", { exact: true });
  const workflowJson = proposal.getByLabel("Content, actions and workflows JSON", { exact: true });
  const requestJson = proposal.getByLabel("Treatment Selector request JSON", { exact: true });
  const contentIds = JSON.parse(await legacyJson.innerText());
  const addressResponse = JSON.parse(await workflowJson.innerText());
  assert.deepEqual(JSON.parse(await requestJson.innerText()), { mid: "DEMO-MID-1003", context: "address-update" });
  assert.deepEqual(contentIds, ["address_update_guide", "fund_account"]);
  assert.deepEqual(addressResponse, marcusCalls.treatment.response.output);
  await proposal.getByRole("button", { name: "Alice · Retirement", exact: true }).click();
  const aliceTsRequest = JSON.parse(await requestJson.innerText());
  assert.deepEqual(aliceTsRequest, { mid: "DEMO-MID-1001", context: "learning" });
  const missingBeneficiary = tsFixtures.defaultCcreRules.find((rule) => rule.contextId === "learning" && rule.contentId === "beneficiary_update")!;
  const aliceAdapter = new FixtureTsAdapter({ scenarioId: "normal", ordinal: 1 }, [], [
    { ...missingBeneficiary, scenarioId: "normal", workflow: beneficiaryReviewWorkflow.recommendation },
  ]);
  const aliceDecision = await aliceAdapter.selectEligibleContent(aliceTsRequest);
  assert.deepEqual(JSON.parse(await legacyJson.innerText()), aliceDecision.contentIds);
  assert.deepEqual(JSON.parse(await workflowJson.innerText()), aliceDecision.decision);
  await proposal.getByRole("link", { name: "View TS contracts", exact: true }).click();
  await page.getByRole("button", { name: "Download treatment-selector.tool.json", exact: true }).waitFor();
  const walkthrough = page.getByRole("group", { name: "Demo walkthrough" });
  const flow = page.getByRole("list", { name: "Turn flow" });
  const stepDetails = page.locator("#step-details");
  const stepInput = stepDetails.locator('pre[aria-label="Input JSON"]').first();
  assert.equal(JSON.parse(await stepInput.innerText()).summaryFollowUpIntentId, "show_balance");
  await flow.getByRole("button", { name: /Experience Composer/ }).click();
  await stepDetails.getByText("How the model gets the balances", { exact: true }).click();
  await stepDetails.getByText("Balances sent back to the model", { exact: true }).waitFor();
  await walkthrough.getByRole("button", { name: "Portfolio summary", exact: true }).click();
  await flow.getByRole("button", { name: /Portfolio Snapshot/ }).click();
  assert.equal(JSON.parse(await stepDetails.locator('pre[aria-label="Output JSON"]').innerText()).cashCents, 1_250_000);
  await walkthrough.getByRole("button", { name: "Create rule", exact: true }).click();
  await flow.getByRole("button", { name: /CCRE glossary/ }).click();
  await stepDetails.getByRole("link", { name: "CCRE glossary", exact: true }).click();
  assert.equal(new URL(page.url()).hash, "#contracts");
  await page.getByRole("heading", { name: "CCRE glossary", exact: true }).last().waitFor();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ccre-glossary.tool.json", exact: true }).click();
  const glossarySchema = await download;
  assert.equal(glossarySchema.suggestedFilename(), "ccre-glossary.tool.json");
  assert.deepEqual(JSON.parse(await readFile(await glossarySchema.path(), "utf8")).input.required, ["turnRef", "routerRunId"]);
  await openCustomerChat(page);
  assert.equal(new URL(page.url()).pathname, "/chat");
  const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
  await sidebar.getByRole("heading", { name: "Chat threads", exact: true }).waitFor();
  assert.equal(await sidebar.locator('a[href^="/admin"]').count(), 0);
  assert.equal(await page.getByText("Test mode", { exact: true }).count(), 0);
  await page.getByRole("heading", { name: "Welcome, Alice.", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Your question", { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole("region", { name: "Your snapshot and suggestions" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Compare balances", exact: true }).isVisible(), false);
  const shortcuts = page.getByRole("navigation", { name: "Workspace shortcuts" });
  await shortcuts.getByRole("button", { name: "Savings goal", exact: true }).click();
  await page.getByRole("img", { name: /Down payment savings from \$7,500 to \$26,000/ }).waitFor();
  await shortcuts.getByRole("button", { name: "Summary", exact: true }).click();
  const logs = page.getByRole("region", { name: "Call log details" });
  await openAdmin(page, "logs");
  await logs.getByText("Send a question to see its call logs.", { exact: true }).waitFor();
  await openCustomerChat(page);
  await page.getByRole("heading", { name: "Welcome, Alice.", exact: true }).waitFor();
  await page.screenshot({ path: resolve(screenshots, "welcome-desktop.png") });
  if (!await page.getByRole("button", { name: /Compare two terms/ }).isVisible()) await page.getByText("Explore suggested questions", { exact: true }).click();
  await page.getByRole("button", { name: /Compare two terms/ }).click();
  await page.getByRole("heading", { name: "Compare balance definitions" }).waitFor();
  await page.locator('[data-renderer="a2ui"]').waitFor();
  assert.equal(await page.getByRole("button", { name: /^\[\d+\] / }).count(), 0);
  await page.getByText("For illustration.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Explain available balance", exact: true }).isVisible(), true);
  assert.equal(await page.getByText("Explore suggested questions", { exact: true }).count(), 0);
  await page.screenshot({ path: resolve(screenshots, "comparison-desktop.png") });

  await page.getByText("View sources", { exact: true }).click();
  await page.getByText("Content catalog · v1", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Helpful", exact: true }).click();
  await page.getByRole("button", { name: "Helpful", exact: true, pressed: true }).waitFor();
  await page.getByRole("button", { name: "Explain available balance", exact: true }).click();
  await page.getByRole("heading", { name: "Available balance", exact: true, level: 3 }).waitFor();
  assert.equal(await page.locator('[data-renderer="a2ui"]').count(), 2);
  assert.equal(await page.getByRole("button", { name: "Explain available balance", exact: true }).isDisabled(), true);

  await page.reload();
  await page.getByRole("heading", { name: "Available balance", exact: true, level: 3 }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Helpful", exact: true, pressed: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /Advisory Reasoning/ }).count(), 0);
  await sidebar.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome, Alice.", exact: true }).waitFor();
  await sidebar.getByRole("button", { name: /^Compare available and current balance/ }).click();
  await page.getByRole("heading", { name: "Available balance", exact: true, level: 3 }).waitFor();
  await openAdmin(page, "inspector");
  const inspector = page.getByRole("region", { name: "Turn inspection details" });
  await inspector.waitFor();
  await page.getByText("Selected topic", { exact: true }).waitFor();
  await page.getByLabel("Chat message").selectOption({ index: 1 });
  await inspector.getByRole("link", { name: "Open call logs", exact: true }).click();
  await logs.waitFor();
  await inspector.waitFor({ state: "hidden" });
  const routerLogs = logs.locator("details.payload-stage").filter({ has: page.getByText("Context Router · 1 attempt", { exact: true }) });
  await page.getByText("Experience Composer · 1 attempt", { exact: true }).waitFor();
  await page.getByText("Treatment Selector · succeeded", { exact: true }).click();
  const mockRequest = page.locator('pre[aria-label="Mock request"]');
  assert.match(await mockRequest.innerText(), /"mid": "DEMO-MID-1001"/);
  await routerLogs.getByText("Context Router · 1 attempt", { exact: true }).click();
  await routerLogs.getByText("Decoded chat input", { exact: true }).click();
  assert.match(await routerLogs.locator('pre[aria-label="Decoded chat input"]').innerText(), /Compare available and current balance\./);
  await routerLogs.getByText("Gateway request body", { exact: true }).click();
  assert.match(await routerLogs.locator('pre[aria-label="Gateway request body"]').innerText(), /"response_format"/);
  await page.screenshot({ path: resolve(screenshots, "call-logs-comparison.png") });
  await logs.getByLabel("Chat message", { exact: true }).selectOption("");
  await routerLogs.getByText("Context Router · 1 attempt", { exact: true }).click();
  await routerLogs.getByText("Decoded chat input", { exact: true }).click();
  assert.match(await routerLogs.locator('pre[aria-label="Decoded chat input"]').innerText(), /available-balance term/);
  await openCustomerChat(page);
  await page.getByRole("heading", { name: "Available balance", exact: true, level: 3 }).waitFor();

  const input = page.getByLabel("Your question");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await input.fill("Explain this slow balance request");
  await input.press("Shift+Enter");
  await input.press("End");
  assert.match(await input.inputValue(), /\n/);
  await input.press("Enter");
  const loading = page.locator(".reply-loading").getByRole("status");
  await loading.waitFor();
  assert.equal(await loading.textContent(), "Preparing your reply.");
  assert.deepEqual(await loading.locator(".reply-dots > span").evaluateAll((dots) =>
    dots.map((dot) => getComputedStyle(dot).animationName)), ["reply-dot-wave", "reply-dot-wave", "reply-dot-wave"]);
  await page.getByRole("button", { name: "End running task", exact: true }).click();
  await page.getByText("Response stopped.", { exact: true }).waitFor();
  await loading.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await page.emulateMedia({ reducedMotion: "reduce" });

  const abortPattern = /\/api\/conversations\/[^/]+\/turns$/;
  await page.route(abortPattern, (route) => route.abort(), { times: 1 });
  await input.fill("Explain the fictional portfolio view.");
  await input.press("Enter");
  await page.getByText("Couldn’t connect. Your draft is still here.", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "Explain the fictional portfolio view.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("heading", { name: "Understanding your portfolio" }).waitFor();

  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  if (!await page.getByRole("button", { name: /Guide me through a task/ }).isVisible()) await page.getByText("Explore suggested questions", { exact: true }).click();
  await page.getByRole("button", { name: /Guide me through a task/ }).click();
  await page.getByRole("heading", { name: "Transfer checklist" }).waitFor();
  assert.deepEqual(await page.locator(".steps-list h4").allTextContents(), [
    "Choose the accounts", "Review the amount", "Review the transfer preview",
  ]);
  await page.getByRole("button", { name: "Explain portfolio terms", exact: true }).click();
  await page.getByRole("heading", { name: "Understanding your portfolio" }).waitFor();

  await openAdmin(page, "tools");
  await page.getByRole("heading", { name: "Tool setup", level: 1 }).waitFor();
  await page.getByRole("heading", { name: /sfield Governed MCP Server/i }).waitFor();
  assert.equal(await page.getByRole("switch", { name: "Treatment Selector", exact: true }).isChecked(), true);
  assert.equal(await page.getByRole("switch", { name: "CCRE glossary", exact: true }).isChecked(), true);
  await page.getByLabel("Response", { exact: true }).selectOption("ranked");
  await page.getByLabel("Add content").selectOption("balance_available_definition");
  await page.getByLabel("Add content").selectOption("balance_current_definition");
  await page.getByRole("button", { name: "Move balance_current_definition up", exact: true }).click();
  await page.getByRole("button", { name: "Run preview" }).click();
  await page.getByText("Matching content", { exact: true }).waitFor();
  assert.deepEqual(await page.getByRole("status").locator("ol code").allTextContents(), [
    "balance_current_definition", "balance_available_definition",
  ]);
  await page.screenshot({ path: resolve(screenshots, "tool-setup-desktop.png") });
  await page.getByLabel("Topic", { exact: true }).selectOption("portsum");
  await page.getByLabel("Response", { exact: true }).selectOption("empty");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Tool settings saved.", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("list", { name: "Content order" }).waitFor();
  assert.equal(await page.getByLabel("Response", { exact: true }).inputValue(), "ranked");
  await page.getByLabel("Topic", { exact: true }).selectOption("portsum");
  assert.equal(await page.getByLabel("Response", { exact: true }).inputValue(), "empty");
  await openCustomerChat(page);
  await page.getByRole("heading", { name: "Understanding your portfolio" }).waitFor();
  const chatWithMock = page.getByLabel("Your question");
  await chatWithMock.fill("Explain the fictional portfolio view.");
  await chatWithMock.press("Enter");
  const plainReply = page.getByText("A portfolio holds investments and cash. Allocation describes how its total value is split. Which part would you like to explore?", { exact: true });
  await plainReply.waitFor();
  await chatWithMock.fill("What did you just say?");
  await chatWithMock.press("Enter");
  await plainReply.nth(1).waitFor();

  await openAdmin(page, "tools");
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  await page.getByLabel("Rule name", { exact: true }).fill("Available definition for learners");
  await page.getByLabel("Content for this rule", { exact: true }).selectOption("balance_available_definition");
  await page.getByLabel("When to show it", { exact: true }).selectOption("persona_is");
  await page.getByLabel("Matching profile", { exact: true }).selectOption("demo-learner");
  await page.getByLabel("CCRE rule text (optional)", { exact: true }).fill("Sample source retained for the CCRE integration.");
  await page.screenshot({ path: resolve(screenshots, "ccre-rule-editor.png"), fullPage: true });
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await page.getByRole("button", { name: "Run preview", exact: true }).click();
  await page.getByText("Matched", { exact: true }).waitFor();
  await page.getByLabel("Demo profile", { exact: true }).selectOption("demo-returning");
  await page.getByRole("button", { name: "Run preview", exact: true }).click();
  await page.getByText("Filtered out", { exact: true }).waitFor();
  assert.deepEqual(await page.getByRole("list", { name: "Matching content in order" }).locator("code").allTextContents(), [
    "balance_current_definition",
  ]);
  await page.screenshot({ path: resolve(screenshots, "ccre-rule-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "Open draft in chat", exact: true }).click();
  if (!await page.getByRole("button", { name: /Compare two terms/ }).isVisible()) await page.getByText("Explore suggested questions", { exact: true }).click();
  await page.getByRole("button", { name: /Compare two terms/ }).click();
  await page.getByText(/available balance is the amount marked ready to use\. Current balance is the total recorded in the ledger\. Which one would you like to understand better\?/i).waitFor();
  await openAdmin(page, "logs");
  await page.getByText("Treatment Selector · succeeded", { exact: true }).click();
  await page.getByText("Mock CCRE evaluation", { exact: true }).click();
  assert.match(await page.locator('pre[aria-label="Mock CCRE evaluation"]').innerText(), /"outcome": "excluded"/);

  const author = await browser.newPage({ httpCredentials: { ...operatorCredentials, origin: preview.url }, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  author.setDefaultTimeout(12_000);
  author.on("pageerror", (error) => pageErrors.push(error.message));
  await author.goto(preview.url + adminPaths.chat);
  await author.getByText("Model connected", { exact: true }).waitFor();
  const authorMessage = author.getByLabel("Your question");
  await authorMessage.fill("Create rule");
  await authorMessage.press("Enter");
  const ruleBlock = author.locator('[data-renderer="a2ui"]').getByRole("region", { name: "Create a CCRE rule" });
  await ruleBlock.getByLabel("Rule name", { exact: true }).fill("Available balance for learners");
  await ruleBlock.getByLabel("Content for this rule", { exact: true }).selectOption("balance_available_definition");
  const namespace = ruleBlock.getByLabel("Field group", { exact: true });
  const attribute = ruleBlock.getByLabel("Field", { exact: true });
  const operator = ruleBlock.getByLabel("Comparison", { exact: true });
  const ruleValue = ruleBlock.getByLabel("Value", { exact: true });
  const expression = ruleBlock.locator("output");
  assert.equal(await namespace.inputValue(), "customer");
  assert.equal(await attribute.inputValue(), "persona");
  assert.equal(await ruleValue.inputValue(), "demo-learner");
  await attribute.selectOption("is_returning");
  await ruleValue.selectOption("false");
  assert.equal(await expression.innerText(), "customer.is_returning == false");
  await namespace.selectOption("conversation");
  assert.equal(await attribute.inputValue(), "turn_number");
  await operator.selectOption("gte");
  await ruleValue.fill("2");
  assert.equal(await expression.innerText(), "conversation.turn_number >= 2");
  await ruleValue.fill("0");
  assert.equal(await ruleBlock.getByRole("button", { name: "Save rule", exact: true }).isDisabled(), true);
  await namespace.selectOption("portfolio");
  assert.equal(await attribute.inputValue(), "cash_usd");
  await operator.selectOption("gt");
  await ruleValue.fill("10000");
  assert.equal(await expression.innerText(), "portfolio.cash_usd > 10000");
  await namespace.selectOption("customer");
  assert.equal(await expression.innerText(), 'customer.persona == "demo-learner"');
  await author.screenshot({ path: resolve(screenshots, "ccre-glossary-chat.png") });
  await ruleBlock.getByRole("button", { name: "Preview rule", exact: true }).click();
  await ruleBlock.getByText("Matched", { exact: true }).waitFor();
  await ruleBlock.getByLabel("Preview profile", { exact: true }).selectOption("demo-returning");
  await ruleBlock.getByRole("button", { name: "Preview rule", exact: true }).click();
  await ruleBlock.getByText("Filtered out", { exact: true }).waitFor();
  const rankedAfterRule = ruleBlock.getByRole("list", { name: "Matching content in order" });
  assert.ok(!(await rankedAfterRule.locator("code").allTextContents()).includes("balance_available_definition"));
  const beforeRuleSave = await author.request.get(preview.url + "/api/admin/tools");
  assert.deepEqual((await beforeRuleSave.json()).setup.ccreRules ?? [], []);
  await ruleBlock.getByRole("button", { name: "Save rule", exact: true }).click();
  await ruleBlock.getByRole("button", { name: "Saved", exact: true, disabled: true }).waitFor();
  await openAdmin(author, "logs");
  await author.getByText("CCRE glossary · succeeded", { exact: true }).click();
  assert.match(await author.locator('pre[aria-label="Glossary tool request"]').innerText(), /"routerRunId"/);
  assert.match(await author.locator('pre[aria-label="Glossary tool response"]').innerText(), /"namespaces".*"customer"/s);
  await openAdmin(author, "chat");
  await ruleBlock.getByRole("heading", { name: "Create a CCRE rule" }).waitFor();
  await authorMessage.fill("Compare available and current balance.");
  await authorMessage.press("Enter");
  await author.getByRole("heading", { name: "Compare balance definitions" }).waitFor();
  await author.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Tool setup", exact: true }).click();
  await author.getByRole("list", { name: "CCRE rules for this context" }).getByText("Available balance for learners", { exact: true }).waitFor();
  await author.getByRole("button", { name: "Edit rule Available balance for learners", exact: true }).click();
  assert.equal(await author.getByLabel("Field group", { exact: true }).inputValue(), "customer");
  assert.equal(await author.getByLabel("Value", { exact: true }).inputValue(), "demo-learner");

  // Start the independent portfolio scenario with its standard shared treatment rules.
  const restoredDefaults = await author.request.post(preview.url + "/api/admin/tools", { data: defaultToolSetup });
  assert.equal(restoredDefaults.status(), 200);
  const portfolioPage = await browser.newPage({ httpCredentials: { ...operatorCredentials, origin: preview.url }, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await portfolioPage.addInitScript(() => localStorage.setItem("cep_expertise_mode", "pro"));
  portfolioPage.setDefaultTimeout(12_000);
  portfolioPage.on("pageerror", (error) => pageErrors.push(error.message));
  await portfolioPage.goto(preview.url + "/planning");
  await portfolioPage.getByRole("link", { name: "Compare profiles", exact: true }).click();
  const aliceProfileTrigger = portfolioPage.getByRole("button", { name: "Profiles, current profile Alice Morgan", exact: true });
  const jordanProfileTrigger = portfolioPage.getByRole("button", { name: "Profiles, current profile Jordan Lee", exact: true });
  const demoProfiles = portfolioPage.getByRole("dialog", { name: "Profiles", exact: true });
  const aliceProfile = demoProfiles.getByRole("article", { name: "Alice Morgan", exact: true });
  const jordanProfile = demoProfiles.getByRole("article", { name: "Jordan Lee", exact: true });
  await aliceProfile.getByText("$12,500", { exact: true }).waitFor();
  await aliceProfile.getByText("Missing", { exact: true }).waitFor();
  await jordanProfile.getByText("$10,000", { exact: true }).waitFor();
  await jordanProfile.getByText("On file", { exact: true }).waitFor();
  await demoProfiles.getByRole("button", { name: "Start chat as Jordan Lee", exact: true }).click();
  await jordanProfileTrigger.waitFor();
  if (!await portfolioPage.getByRole("button", { name: /Learn about retirement/ }).isVisible()) await portfolioPage.getByText("Explore suggested questions", { exact: true }).click();
  await portfolioPage.getByRole("button", { name: /Learn about retirement/ }).click();
  await portfolioPage.getByRole("heading", { name: "Retirement planning basics", exact: true }).waitFor();
  assert.equal(await portfolioPage.getByRole("heading", { name: "Update your beneficiaries", exact: true }).count(), 0);
  await jordanProfileTrigger.click();
  await demoProfiles.getByRole("button", { name: "Start chat as Alice Morgan", exact: true }).click();
  await aliceProfileTrigger.waitFor();
  await portfolioPage.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Profiles, current profile Alice Morgan");
  const portfolioQuestion = portfolioPage.getByLabel("Your question");
  // The preview must render from SSE even while the final turn read is held.
  const turnRead = /\/api\/turns\/[^/]+$/;
  const pendingReply = portfolioPage.locator(".assistant-message:has(.reply-loading)");
  const pendingCard = Promise.all([pendingReply.elementHandle(), pendingReply.locator(".reply-skeleton").boundingBox()]);
  let releaseFinal!: () => void;
  const finalRead = new Promise<void>((resolve) => { releaseFinal = resolve; });
  await portfolioPage.route(turnRead, async (route) => { await finalRead; await route.continue(); });
  await portfolioQuestion.fill("Let me know my portfolio summary.");
  await portfolioQuestion.press("Enter");
  const [pendingElement, placeholder] = await pendingCard;
  const snapshot = portfolioPage.locator('[data-renderer="a2ui"]').getByRole("region", { name: "Portfolio snapshot" });
  await snapshot.getByText("$12,500", { exact: true }).waitFor();
  const waitingForRecommendations = portfolioPage.getByRole("status").filter({ hasText: "Checking for recommendations." });
  await waitingForRecommendations.waitFor();
  assert.equal(await waitingForRecommendations.locator(".reply-dots > span").first().evaluate((dot) =>
    getComputedStyle(dot).animationName), "none");
  const earlyCard = await snapshot.elementHandle();
  const cashRecommendation = portfolioPage.getByText("You have $12,500 in cash. Would you like to explore investing options?", { exact: true });
  assert.equal(await cashRecommendation.count(), 0);
  assert.ok(await pendingElement.evaluate((row) => row.isConnected && row.hasAttribute("data-live-reply")));
  const finished = await snapshot.boundingBox();
  assert.ok(placeholder && finished);
  assert.equal(finished.x, placeholder.x);
  assert.equal(finished.width, placeholder.width);
  assert.ok(Math.abs(finished.y - placeholder.y) < 2);
  assert.equal(await snapshot.evaluate((card) => getComputedStyle(card.closest(".surface-child")!).animationName), "none");
  const simulation = snapshot.getByRole("button", { name: "Simulate cash deployment" });
  await snapshot.getByRole("button", { name: "Show dollar amounts" }).click();
  assert.equal(await snapshot.locator(".portfolio-allocation li").filter({ hasText: "Cash" }).locator("strong").innerText(), "$12,500");
  await snapshot.getByRole("button", { name: "Show percentages" }).click();
  await simulation.click();
  await snapshot.getByRole("button", { name: "Growth (80/20)" }).click();
  const stockShare = () => snapshot.locator(".portfolio-allocation li").filter({ hasText: "Stocks" }).locator("strong").innerText();
  assert.equal(await stockShare(), "71%");
  const discuss = snapshot.getByRole("button", { name: "Discuss this allocation" });
  assert.ok(await discuss.isDisabled());
  releaseFinal();
  await cashRecommendation.waitFor();
  await waitingForRecommendations.waitFor({ state: "hidden" });
  await portfolioPage.unroute(turnRead);
  assert.doesNotMatch(await pendingElement.innerText(), /mode=|exp=|blocks=|sources=|actions=/);
  assert.ok(await earlyCard.evaluate((card) => card.isConnected));
  assert.ok(await discuss.isEnabled());
  assert.equal(await stockShare(), "71%");
  await portfolioPage.screenshot({ path: resolve(screenshots, "portfolio-learner-chat.png") });
  const helpful = portfolioPage.getByRole("button", { name: "Helpful", exact: true });
  await helpful.click();
  await portfolioPage.getByRole("button", { name: "Helpful", exact: true, pressed: true }).waitFor();
  assert.equal(await simulation.getAttribute("aria-expanded"), "true");
  assert.equal(await stockShare(), "71%");
  await openAdmin(portfolioPage, "logs");
  const portfolioLogs = portfolioPage.getByRole("region", { name: "Call log details" });
  const timings = portfolioLogs.getByRole("region", { name: "Call timings" });
  await timings.getByText("Portfolio card shown", { exact: true }).waitFor();
  await timings.getByText("Final reply shown", { exact: true }).waitFor();
  await timings.getByRole("rowheader", { name: "Treatment Selector", exact: true }).waitFor();
  for (const stage of ["Context Router · 1 attempt", "Treatment Selector · succeeded", "Portfolio Snapshot · succeeded", "Experience Composer · 1 attempt"]) {
    await portfolioLogs.getByText(stage, { exact: true }).waitFor();
  }
  await portfolioPage.screenshot({ path: resolve(screenshots, "call-logs-portfolio.png") });
  await portfolioLogs.getByText("Portfolio Snapshot · succeeded", { exact: true }).click();
  assert.match(await portfolioLogs.locator('pre[aria-label="Portfolio Snapshot tool request"]').innerText(), /"routeDecisionId"/);
  assert.match(await portfolioLogs.locator('pre[aria-label="Portfolio Snapshot tool response"]').innerText(), /"cashCents": 1250000/);
  await openAdmin(portfolioPage, "tools");
  await portfolioPage.getByLabel("Topic", { exact: true }).selectOption("portsum");
  await portfolioPage.getByLabel("Demo profile", { exact: true }).selectOption("demo-returning");
  await portfolioPage.getByRole("button", { name: "Run preview", exact: true }).click();
  const cashRuleResult = portfolioPage.getByRole("status").getByRole("listitem").filter({
    has: portfolioPage.getByText("Cash above $10,000", { exact: true }),
  });
  await cashRuleResult.getByText("Filtered out", { exact: true }).waitFor();
  await portfolioPage.getByRole("button", { name: "Open in chat", exact: true }).click();
  await jordanProfileTrigger.waitFor();
  await portfolioQuestion.fill("Let me know my portfolio summary.");
  await portfolioQuestion.press("Enter");
  await snapshot.getByText("$10,000", { exact: true }).waitFor();
  assert.equal(await portfolioPage.getByRole("heading", { name: "Explore investing options", exact: true }).count(), 0);
  await portfolioPage.screenshot({ path: resolve(screenshots, "portfolio-returning-chat.png") });
  await openAdmin(portfolioPage, "tools");
  const editor = portfolioPage.getByRole("region", { name: "Funding preview workflow", exact: true });
  await portfolioPage.getByLabel("Topic", { exact: true }).selectOption("address-update");
  await portfolioPage.getByRole("button", { name: "Edit rule Account is unfunded" }).click();
  const attachment = portfolioPage.getByRole("combobox", { name: /Workflow on click/ });
  await attachment.selectOption("");
  await portfolioPage.getByRole("button", { name: "Update rule", exact: true }).click();
  await portfolioPage.getByRole("button", { name: "Edit rule Account is unfunded" }).click();
  assert.equal(await attachment.inputValue(), "");
  await attachment.selectOption("account.funding.preview@1.0.0");
  await portfolioPage.getByRole("button", { name: "Update rule", exact: true }).click();
  await editor.getByLabel("How to run funding preview", { exact: true }).selectOption("ordered");
  const editorOrder = editor.getByRole("list", { name: "Funding workflow tool order", exact: true }).locator("code");
  await editor.getByLabel("Add workflow tool", { exact: true }).selectOption(fundingToolRef("fundingStatus"));
  await editor.getByRole("button", { name: "Move " + fundingToolRef("fundingStatus") + " up", exact: true }).click();
  const workflowSteps = [fundingToolRef("fundingStatus"), ...defaultFundingWorkflow.steps];
  assert.deepEqual(await editorOrder.allTextContents(), workflowSteps);
  await editor.getByRole("button", { name: "Move " + fundingToolRef("fundingPreview") + " up", exact: true }).click();
  await editor.getByText("Move Funding options before Build funding preview.", { exact: true }).waitFor();
  const saveSettings = portfolioPage.getByRole("button", { name: "Save settings", exact: true });
  assert.equal(await saveSettings.isDisabled(), true);
  await editor.getByRole("button", { name: "Move " + fundingToolRef("fundingPreview") + " down", exact: true }).click();
  await saveSettings.click();
  await portfolioPage.getByText("Tool settings saved.", { exact: true }).waitFor();
  await portfolioPage.reload();
  await editorOrder.first().waitFor();
  assert.deepEqual(await editorOrder.allTextContents(), workflowSteps);
  await openAdmin(portfolioPage, "chat");
  await jordanProfileTrigger.click();
  const marcusProfile = demoProfiles.getByRole("article", { name: "Marcus Reed", exact: true });
  await marcusProfile.getByText("Awaiting first deposit", { exact: true }).waitFor();
  await marcusProfile.getByRole("button", { name: "Start chat as Marcus Reed", exact: true }).click();
  if (!await portfolioPage.getByRole("button", { name: /Update mailing address/ }).isVisible()) await portfolioPage.getByText("Explore suggested questions", { exact: true }).click();
  const addressSubmission = portfolioPage.waitForResponse((r) => r.request().method() === "POST" && /\/conversations\/[^/]+\/turns$/.test(r.url()))
    .then(async (r) => ({ request: r.request().postDataJSON(), response: await r.json() }));
  await portfolioPage.getByRole("button", { name: /Update mailing address/ }).click();
  await portfolioPage.getByRole("heading", { name: "Update your mailing address", exact: true }).waitFor();
  await portfolioPage.getByRole("heading", { name: "Fund your account", exact: true }).waitFor();
  await portfolioPage.getByText("Suggested next step", { exact: true }).waitFor();
  await openAdmin(portfolioPage, "logs");
  const scoresStage = portfolioLogs.locator(".payload-stage").filter({ hasText: "Treatment Selector topic scores · succeeded" });
  await scoresStage.getByText("Treatment Selector topic scores · succeeded", { exact: true }).click();
  const actualScoresRequest = JSON.parse(await scoresStage.getByLabel("Mock topic scores request", { exact: true }).innerText());
  assert.equal(actualScoresRequest.mid, marcusCalls.scores.treatmentSelectorInput.mid);
  assert.deepEqual(actualScoresRequest.contextIds, [...marcusCalls.scores.treatmentSelectorInput.contextIds, "wealth-next-best-offers"]);
  const actualScores = JSON.parse(await scoresStage.getByLabel("Topic scores response", { exact: true }).innerText());
  assert.deepEqual(actualScores, { ...topicScores, scores: [...topicScores.scores, { contextId: "wealth-next-best-offers", score: null }] });
  const compare = portfolioLogs.getByRole("region", { name: "Treatment Selector response comparison" });
  assert.deepEqual(JSON.parse(await compare.getByLabel("Legacy response · content IDs", { exact: true }).innerText()), contentIds);
  assert.deepEqual(JSON.parse(await compare.getByLabel("New response · content, actions and workflows", { exact: true }).innerText()), addressResponse);
  await portfolioLogs.getByText("Treatment Selector · succeeded", { exact: true }).click();
  await portfolioLogs.getByText("Mock CCRE evaluation", { exact: true }).click();
  const fundingEvaluation = JSON.parse(await portfolioLogs.locator('pre[aria-label="Mock CCRE evaluation"]').innerText());
  assert.deepEqual(fundingEvaluation.results, [{ name: "Account is unfunded", contentId: "fund_account", outcome: "matched" }]);
  assert.deepEqual(JSON.parse(await portfolioLogs.getByLabel("Tool response", { exact: true }).innerText()), addressResponse);
  await openAdmin(portfolioPage, "help");
  const unclicked = portfolioPage.locator("#ts-sfield");
  await unclicked.getByRole("button", { name: "Preview funding", exact: true }).click();
  await unclicked.getByText("No click on this recommendation was recorded for this decision.").waitFor();
  const beforeFunding = portfolioPage.getByRole("region", { name: "System architecture", exact: true });
  await beforeFunding.getByRole("button", { name: "After a funding click", exact: true }).click();
  await beforeFunding.getByRole("button", { name: /^Arrow 1 ·/ }).press("Enter");
  await portfolioPage.getByRole("dialog").getByText(/has no recorded Preview funding click/).waitFor();
  await portfolioPage.keyboard.press("Escape");
  await openAdmin(portfolioPage, "chat");
  const addressForm = portfolioPage.getByRole("region", { name: "Prepare an address change", exact: true });
  for (const [field, value] of Object.entries({ "Street address": "100 Example Lane", City: "Sample City", "State or region": "MA", "ZIP or postal code": "02110" })) {
    await addressForm.getByLabel(field, { exact: true }).fill(value);
  }
  await addressForm.getByRole("button", { name: "Prepare an address change" }).click();
  await portfolioPage.getByRole("heading", { name: "Address change prepared", exact: true }).waitFor();
  const fundingSubmission = portfolioPage.waitForResponse((r) => r.request().method() === "POST" && /\/experiences\/[^/]+\/actions$/.test(r.url()))
    .then(async (r) => ({ request: r.request().postDataJSON(), response: await r.json() }));
  await portfolioPage.getByRole("button", { name: "Preview funding", exact: true, disabled: false }).click();
  await portfolioPage.locator('[data-renderer="a2ui"]').getByRole("region", { name: "Funding preview", exact: true }).waitFor();
  await portfolioPage.getByText("$250 by bank transfer", { exact: true }).waitFor();
  await openAdmin(portfolioPage, "logs");
  await portfolioLogs.getByText("Funding preview workflow", { exact: true }).waitFor();
  await portfolioLogs.getByRole("link", { name: /Source message/ }).waitFor();
  assert.deepEqual(JSON.parse(await compare.getByLabel("New response · content, actions and workflows", { exact: true }).innerText()), addressResponse);
  await portfolioLogs.getByText("Workflow definition", { exact: true }).click();
  assert.deepEqual(JSON.parse(await portfolioLogs.getByLabel("Workflow definition", { exact: true }).innerText()), {
    ...defaultFundingWorkflow, steps: workflowSteps,
  });
  assert.deepEqual(await portfolioLogs.locator(".payload-stage > summary").allTextContents(), [
    "Funding preview workflow", "Check funding status · succeeded", "Funding options · succeeded", "Build funding preview · succeeded",
  ]);
  const optionsResult = JSON.parse(await portfolioLogs.getByLabel("Funding options tool response", { exact: true }).innerText());
  const previewInput = JSON.parse(await portfolioLogs.getByLabel("Build funding preview tool request", { exact: true }).innerText());
  const previewResult = JSON.parse(await portfolioLogs.getByLabel("Build funding preview tool response", { exact: true }).innerText());
  assert.equal(previewInput.methodId, optionsResult.methods[0].methodId);
  assert.equal(previewResult.amountCents, 25_000);

  const sourceLink = await portfolioLogs.getByRole("link", { name: /Source message/ }).getAttribute("href");
  const sourceParams = new URL(sourceLink!, preview.url).searchParams;
  await portfolioPage.goto(preview.url + "/admin/help?" + sourceParams + "#ts-sfield");
  const liveDiagram = portfolioPage.locator("#ts-sfield");
  const runId = sourceParams.get("turn")!;
  const [savedRun] = await (await portfolioPage.request.get(preview.url + "/api/admin/treatment-runs?personaId=demo-new-account&context=address-update&turn=" + runId)).json() as TreatmentRun[];
  const readLog = async (id: string): Promise<TurnPayloads> => (await portfolioPage.request.get(preview.url + "/api/admin/logs/" + id)).json();
  const sourceLog = await readLog(runId);
  const modal = portfolioPage.getByRole("dialog");
  const readJson = async (scope: Locator, title: string) => JSON.parse(await scope.getByLabel(title, { exact: true }).innerText());
  for (const step of [1, 2, 3, 4, 5]) {
    const button = liveDiagram.getByRole("button", { name: new RegExp("^Step " + step + " ·") });
    await button.click();
    await modal.getByRole("link", { name: "Open the source turn in Logs" }).waitFor();
    if (step === 1) assert.equal((await readJson(modal, "Saved customer message")).id, runId);
    if (step === 2) assert.deepEqual(await readJson(modal, "TS request"), sourceLog.treatment?.mockInput?.data);
    if (step === 3) assert.deepEqual(await readJson(modal, "TS response returned to sfield"), sourceLog.treatment?.result?.data);
    if (step === 4) assert.ok((await readJson(modal, "A2UI messages delivered to chat"))[0].createSurface.surfaceId);
    if (step === 5) assert.equal(await modal.getByRole("button", { name: "Preview funding", exact: true }).count(), 1);
    await portfolioPage.keyboard.press("Escape");
    assert.equal(await button.evaluate((element) => element === document.activeElement), true);
  }
  for (const click of savedRun.clicks) {
    await liveDiagram.getByRole("button", { name: click.label, exact: true }).click();
    const expectedRule = sourceLog.treatment!.comparison!.reasons!.find((r) => r.kind === click.kind && r.id === click.id && r.version === click.version)!;
    await liveDiagram.getByText(expectedRule.name, { exact: true }).click();
    assert.deepEqual(await readJson(liveDiagram, "Matched rule and recommendation"), expectedRule);
    assert.equal(new URL((await liveDiagram.getByRole("link", { name: "Open this click in Logs" }).getAttribute("href"))!, preview.url).searchParams.get("turn"), click.turnId);
    const childLog = await readLog(click.turnId);
    const calls = (click.kind === "workflow" ? childLog.workflow?.calls : childLog.agentic?.calls)!;
    const summaries = liveDiagram.locator(".ts-recorded-calls > li > details > summary");
    assert.deepEqual(await summaries.allTextContents(), calls.map((call) => call.tool + " · " + call.status));
    for (const [i, call] of calls.entries()) {
      await summaries.nth(i).click();
      assert.deepEqual(await readJson(liveDiagram, call.tool + " tool request"), call.registryInput.data);
      assert.deepEqual(await readJson(liveDiagram, call.tool + " tool response"), call.result?.data);
      await summaries.nth(i).click();
    }
    await liveDiagram.getByText(expectedRule.name, { exact: true }).click();
  }
  await liveDiagram.screenshot({ path: resolve(screenshots, "ts-sfield-handoff.png") });
  const recordedMap = portfolioPage.getByRole("region", { name: "System architecture", exact: true });
  const fundingClick = savedRun.clicks.find((click) => click.kind === "workflow" && click.id === "account.funding.preview")!;
  const recordedJourney = portfolioPage.getByRole("region", { name: "Customer interaction map" });
  await recordedJourney.getByRole("link", { name: /Find the intent/ }).click();
  assert.equal(new URL((await recordedJourney.getByRole("link", { name: "Marcus’s saved message in Logs" }).getAttribute("href"))!, preview.url).searchParams.get("turn"), savedRun.turnId);
  await recordedJourney.getByRole("link", { name: /Follow up/ }).click();
  assert.equal(new URL((await recordedJourney.getByRole("link", { name: "Marcus’s saved click in Logs" }).getAttribute("href"))!, preview.url).searchParams.get("turn"), fundingClick.turnId);
  const fundingLog = await readLog(fundingClick.turnId);
  for (const [opening, receipts, submission] of [
    ["Chat message", sourceLog, await addressSubmission], ["After a funding click", fundingLog, await fundingSubmission],
  ] as const) {
    await recordedMap.getByRole("button", { name: opening, exact: true }).click();
    const arrows = recordedMap.getByRole("button", { name: /^Arrow \d+ ·/ });
    const isChat = opening === "Chat message";
    assert.equal(await arrows.count(), isChat ? 23 : 11);
    assert.deepEqual(receipts.handoffs?.submission?.request.data, submission.request);
    assert.deepEqual(receipts.handoffs?.submission?.response.data, submission.response);
    for (const [i, arrow] of (await arrows.all()).entries()) {
      const title = (await arrow.getAttribute("aria-label"))!;
      assert.ok(title.startsWith("Arrow " + (i + 1) + " ·"));
      await arrow.click();
      await modal.getByRole("heading", { name: title, exact: true }).waitFor();
      await modal.getByRole("link", { name: "Address update in Logs" }).waitFor();
      if (!isChat || i === 18) {
        assert.equal(new URL((await modal.getByRole("link", { name: "Funding click in Logs" }).getAttribute("href"))!, preview.url).searchParams.get("turn"), fundingClick.turnId);
      }
      if (i === 0 || (isChat && i === 18)) {
        const captured = isChat && i === 18 ? fundingLog : receipts;
        assert.deepEqual(await readJson(modal, "Request"), captured.handoffs!.submission!.request.data);
        assert.deepEqual(await readJson(modal, "Response"), captured.handoffs!.submission!.response.data);
      }
      if (isChat && [1, 2, 3].includes(i)) {
        assert.deepEqual(await modal.getByRole("list", { name: "Flows in the model request" }).getByRole("listitem").allTextContents(),
          receipts.sentFlowList!.flowIds);
        if (i === 1) await modal.getByRole("link", { name: "Open chat routing flows in Tool setup" }).waitFor();
        if (i === 2) assert.deepEqual(await readJson(modal, "Flow selection request"), receipts.handoffs!.flowRouting!.request.data);
        if (i === 3) assert.deepEqual(await readJson(modal, "Flow selection response"), receipts.handoffs!.flowRouting!.response.data);
      }
      if (isChat && [7, 8, 13, 14].includes(i)) {
        const stage = i < 9 ? receipts.router : receipts.composer;
        assert.deepEqual(await readJson(modal, "Gateway request body"), stage?.attempts[0].exchange?.request.data);
        assert.deepEqual(await readJson(modal, "Gateway response"), stage?.attempts[0].exchange?.response?.data);
        if (i === 7) {
          await modal.getByText(/^Topics, supported intents and member scores/).click();
          await modal.getByRole("row").filter({ hasText: /address-update/ }).getByText("0.78").waitFor();
          await modal.getByRole("cell", { name: /Wealth Next-Best Recommendations/ }).waitFor();
          assert.equal((await readJson(modal, "Customer fields in the router request")).fundingStatus, "unfunded");
        }
      }
      if (isChat && [9, 10, 21].includes(i)) assert.deepEqual(await readJson(modal, "TS response"), receipts.treatment?.result?.data);
      if (!isChat && [2, 3].includes(i)) {
        const tools = modal.getByRole("list", { name: "Recorded tool calls in order" });
        assert.deepEqual(await tools.locator("li > details > summary").allTextContents(), receipts.workflow!.calls.map((c) => c.tool + " · " + c.status));
        for (const call of receipts.workflow!.calls) {
          assert.deepEqual(await readJson(tools, call.tool + " tool request"), call.registryInput.data);
          assert.deepEqual(await readJson(tools, call.tool + " tool response"), call.result?.data);
        }
      }
      if (i === (isChat ? 16 : 5)) assert.deepEqual(await readJson(modal, "Response"), receipts.handoffs!.compiler!.response.data);
      if (i === (isChat ? 17 : 6)) assert.deepEqual(await readJson(modal, "Recorded experience.ready event"), receipts.handoffs!.readyEvent!.data);
      if (!isChat && i === 7) assert.deepEqual(await readJson(modal, "Browser render acknowledgement"), receipts.handoffs!.renderReceipt!.data);
      await portfolioPage.keyboard.press("Escape");
      assert.equal(await arrow.evaluate((element) => element === document.activeElement), true);
    }
  }
  await recordedMap.getByRole("button", { name: "Chat message", exact: true }).click();
  await recordedMap.getByText("Eligible recommendations", { exact: true }).click();
  await modal.getByRole("heading", { name: "Arrow 11 · Return eligible recommendations" }).waitFor();
  await portfolioPage.keyboard.press("Escape");
  await recordedMap.getByRole("button", { name: "Treatment Selector", exact: true }).click();
  await recordedMap.getByRole("button", { name: "Inspect recorded decision" }).click();
  assert.deepEqual(await readJson(modal, "TS response returned to sfield"), sourceLog.treatment?.result?.data);
  await portfolioPage.keyboard.press("Escape");
  const liveSequence = portfolioPage.getByRole("list", { name: "Chat interaction sequence" });
  await liveSequence.getByRole("button", { name: /^Step 5 ·/ }).click();
  assert.deepEqual(await readJson(modal, "Supported topic catalog tool request"), sourceLog.catalogLookup?.registryInput.data);
  assert.deepEqual(await readJson(modal, "Supported topic catalog tool response"), sourceLog.catalogLookup?.result?.data);
  await portfolioPage.keyboard.press("Escape");
  await liveSequence.getByRole("button", { name: /^Step 11 ·/ }).click();
  assert.ok((await readJson(modal, "Eligible candidates in the composer request")).length > 0);
  await portfolioPage.keyboard.press("Escape");
  await liveSequence.getByRole("button", { name: /^Step 10 ·/ }).click();
  assert.deepEqual(await readJson(modal, "TS response returned to sfield"), sourceLog.treatment?.result?.data);
  await portfolioPage.keyboard.press("Escape");
  await openAdmin(portfolioPage, "tools");
  await editor.getByLabel("How to run funding preview", { exact: true }).selectOption("agent");
  await editor.getByLabel("Goal", { exact: true }).waitFor();
  await editor.getByLabel("Tool call limit", { exact: true }).fill("6");
  await saveSettings.click();
  await portfolioPage.getByText("Tool settings saved.", { exact: true }).waitFor();
  await openAdmin(portfolioPage, "chat");
  await portfolioPage.getByRole("button", { name: "Profiles, current profile Marcus Reed", exact: true }).click();
  await marcusProfile.getByRole("button", { name: "Start chat as Marcus Reed", exact: true }).click();
  if (!await portfolioPage.getByRole("button", { name: /Update mailing address/ }).isVisible()) await portfolioPage.getByText("Explore suggested questions", { exact: true }).click();
  await portfolioPage.getByRole("button", { name: /Update mailing address/ }).click();
  await portfolioPage.getByRole("button", { name: "Preview funding", exact: true }).click();
  await portfolioPage.getByText("Which funding method would you like to preview?", { exact: true }).waitFor();
  const fundingChoices = portfolioPage.locator('[data-renderer="a2ui"]').getByRole("region", { name: "Funding options", exact: true });
  await fundingChoices.getByRole("heading", { name: "Bank transfer", exact: true }).waitFor();
  await fundingChoices.getByRole("heading", { name: "Transfer from another account", exact: true }).waitFor();
  await portfolioQuestion.fill("Use the cash management account.");
  await portfolioQuestion.press("Enter");
  const guidedPreview = portfolioPage.locator('[data-renderer="a2ui"]').getByRole("region", { name: "Funding preview", exact: true });
  await guidedPreview.getByText("Cash management account", { exact: true }).waitFor();
  await openAdmin(portfolioPage, "logs");
  await portfolioLogs.getByText("Customer reply that resumed this run", { exact: true }).click();
  assert.match(await portfolioLogs.getByLabel("Customer reply that resumed this run", { exact: true }).innerText(), /Use the cash management account/);

  const goalPage = await browser.newPage({ httpCredentials: { ...operatorCredentials, origin: preview.url }, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  goalPage.setDefaultTimeout(12_000);
  goalPage.on("pageerror", (error) => pageErrors.push(error.message));
  await goalPage.goto(preview.url);
  if (!await goalPage.getByRole("button", { name: /Home-buying goal/ }).isVisible()) await goalPage.getByText("Explore suggested questions", { exact: true }).click();
  await goalPage.getByRole("button", { name: /Home-buying goal/ }).click();
  const goal = goalPage.locator('[data-renderer="a2ui"]').getByRole("region", { name: "Home down payment", exact: true });
  const goalValues = goal.locator(".goal-values");
  await goal.getByText("52% saved", { exact: true }).waitFor();
  await goalValues.getByText("$26,000", { exact: true }).waitFor();
  await goalValues.getByText("$50,000", { exact: true }).waitFor();
  await goalValues.getByText("$24,000", { exact: true }).waitFor();
  await goalPage.waitForFunction(() => {
    const chart = document.querySelector<HTMLCanvasElement>(".goal-figure canvas");
    const context = chart?.getContext("2d");
    return chart && context && context.getImageData(0, 0, chart.width, chart.height).data.some((value) => value > 0);
  });
  await goalPage.screenshot({ path: resolve(screenshots, "home-goal-desktop.png") });
  await goal.getByText("View monthly values", { exact: true }).click();
  assert.equal(await goal.getByRole("row").count(), 7);
  await openAdmin(goalPage, "logs");
  await goalPage.getByText("Goal Progress · succeeded", { exact: true }).click();
  assert.match(await goalPage.locator('pre[aria-label="Goal Progress tool response"]').innerText(), /"targetCents": 5000000/);

  const mobile = await browser.newPage({ httpCredentials: { ...operatorCredentials, origin: preview.url }, viewport: { width: 360, height: 780 }, isMobile: true, deviceScaleFactor: 1, reducedMotion: "reduce", hasTouch: true });
  mobile.setDefaultTimeout(12_000);
  await mobile.goto(preview.url + "/planning");
  const retirementLink = mobile.getByRole("navigation", { name: "Planning topics" }).getByRole("link", { name: "Retirement", exact: true });
  await retirementLink.waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await retirementLink.click();
  await mobile.getByRole("heading", { name: "Welcome, Alice.", exact: true }).waitFor();
  const mobileMessage = mobile.getByLabel("Your question");
  assert.equal(await mobileMessage.inputValue(), "I'd like to learn about retirement.");
  await mobileMessage.fill("");
  const mobileMenu = mobile.getByRole("button", { name: "Show conversations" });
  await openAdmin(mobile, "help");
  await mobile.getByRole("heading", { name: "How CEP & sfield work", exact: true }).waitFor();
  const mobileJourney = mobile.getByRole("region", { name: "Customer interaction map" });
  await mobileJourney.getByRole("link", { name: /Build the reply/ }).press("Enter");
  await mobileJourney.getByRole("table", { name: "Exchanges for Build the reply" }).waitFor();
  assert.equal(await mobile.evaluate(() => window.scrollY), 0);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const phoneMap = mobile.getByRole("region", { name: "System architecture", exact: true });
  await phoneMap.locator(".sa-canvas.sa-compact").waitFor();
  const phoneArrow = phoneMap.getByRole("button", { name: "Arrow 11 · Return eligible recommendations" });
  await phoneArrow.press("Space");
  await mobile.getByRole("dialog", { name: "Arrow 11 · Return eligible recommendations" }).waitFor();
  await mobile.keyboard.press("Escape");
  await phoneMap.getByRole("button", { name: "sfield runtime", exact: true }).click();
  await assertArchitectureLabelsFit(phoneMap);
  await phoneMap.locator(".sa-canvas").screenshot({ path: resolve(screenshots, "chat-system-architecture-mobile.png") });
  await phoneMap.getByRole("button", { name: "After a funding click", exact: true }).click();
  await assertArchitectureLabelsFit(phoneMap);
  const mobileBounds = await phoneMap.boundingBox();
  assert.ok(mobileBounds && mobileBounds.width <= 360);
  await mobile.getByRole("button", { name: "App server to sfield handoff · step 9", exact: true }).click();
  const mobileExchange = mobile.getByRole("dialog", { name: "Step 9 · App server to sfield", exact: true });
  await mobileExchange.getByText("Marcus Reed", { exact: true }).waitFor();
  assert.deepEqual(await readExchange(mobileExchange), marcusCalls.treatment);
  const exchangeBox = await mobileExchange.boundingBox();
  assert.ok(exchangeBox && exchangeBox.width <= 360, "The exchange drawer fits the mobile viewport");
  await mobileExchange.getByRole("button", { name: "Close exchange details", exact: true }).click();
  await mobile.getByRole("link", { name: "sfield", exact: true }).click();
  await mobile.getByRole("heading", { name: "Registered tools", exact: true }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.getByRole("link", { name: "Treatment Selector’s role", exact: true }).click();
  await mobile.getByRole("button", { name: "Alice · Retirement", exact: true }).click();
  await mobile.getByText("Compare the legacy and current TS responses", { exact: true }).click();
  assert.deepEqual(JSON.parse(await mobile.getByLabel("Content, actions and workflows JSON", { exact: true }).innerText()), aliceDecision.decision);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.getByLabel("Select a contract", { exact: true }).selectOption("render");
  await mobile.getByRole("heading", { name: "A2UI surfaces and actions", exact: true }).waitFor();
  await openCustomerChat(mobile);
  await mobileMenu.click();
  assert.equal(await mobile.getByRole("complementary", { name: "Workspace navigation" }).locator('a[href^="/admin"]').count(), 0);
  await mobile.getByRole("button", { name: "Profiles, current profile Alice Morgan", exact: true }).click();
  const mobileProfiles = mobile.getByRole("dialog", { name: "Profiles", exact: true });
  await mobileProfiles.getByRole("heading", { name: "Jordan Lee", exact: true }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobileProfiles.getByRole("button", { name: "Close profiles", exact: true }).click();
  await mobileMenu.click();
  await mobile.getByRole("button", { name: "Close conversation navigation" }).click();
  if (!await mobile.getByRole("button", { name: /Compare two terms/ }).isVisible()) await mobile.getByText("Explore suggested questions", { exact: true }).click();
  await mobile.getByRole("button", { name: /Compare two terms/ }).click();
  await mobile.getByRole("heading", { name: "Compare balance definitions" }).waitFor();
  const columns = await mobile.locator(".compare-column").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().left));
  assert.equal(columns[0], columns[1]);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await mobile.getByLabel("Your question").isVisible(), true);
  const visibility = await mobile.getByRole("heading", { name: "Compare balance definitions" }).boundingBox();
  assert.ok(visibility && visibility.y >= 57, "The new mobile response starts in view");
  await mobile.screenshot({ path: resolve(screenshots, "comparison-mobile.png") });
  await mobileMessage.fill("Let me know my portfolio summary.");
  await mobileMessage.press("Enter");
  await mobile.locator('[data-renderer="a2ui"]').getByRole("heading", { name: "Portfolio snapshot", exact: true }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await openAdmin(mobile, "logs");
  const mobileLogs = mobile.getByRole("region", { name: "Call log details" });
  await mobileLogs.getByText("Portfolio Snapshot · succeeded", { exact: true }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await openCustomerChat(mobile);
  await mobile.locator('[data-renderer="a2ui"]').getByRole("heading", { name: "Portfolio snapshot", exact: true }).waitFor();
  await mobile.waitForFunction(() => {
    const scroll = document.querySelector(".thread-scroll");
    return scroll && scroll.scrollHeight > scroll.clientHeight && Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) <= 1;
  });
  await mobileMessage.fill("Show my mortgage goal.");
  await mobileMessage.press("Enter");
  const mobileGoal = mobile.locator('[data-renderer="a2ui"]').getByRole("region", { name: "Home down payment", exact: true });
  await mobileGoal.getByRole("img", { name: /Down payment savings/ }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await openAdmin(mobile, "chat");
  await mobile.getByText("Model connected", { exact: true }).waitFor();
  await mobileMessage.fill("Create a rule");
  await mobileMessage.press("Enter");
  const mobileRule = mobile.locator('[data-renderer="a2ui"]').getByRole("region", { name: "Create a CCRE rule" });
  await mobileRule.getByLabel("Field group", { exact: true }).waitFor();
  const mobileCard = await mobileRule.boundingBox();
  assert.ok(mobileCard && mobileCard.x >= 0 && mobileCard.x + mobileCard.width <= 360, "The rule editor fits the mobile conversation");
  await openAdmin(mobile, "tools");
  await mobile.getByRole("heading", { name: "Treatment Selector test settings" }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.getByRole("button", { name: "Create rule", exact: true }).click();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.getByRole("button", { name: "Cancel", exact: true }).click();
  await mobile.getByRole("button", { name: "Run preview" }).click();
  await mobile.getByText("Matching content", { exact: true }).waitFor();
  await mobile.screenshot({ path: resolve(screenshots, "tool-setup-mobile.png"), fullPage: true });
  const fallback = await browser.newPage({httpCredentials: { ...operatorCredentials, origin: preview.url }});
  await fallback.route(/\/api\/turns\/turn_[a-f0-9]+$/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    if (payload.experience) payload.experience.messages[0].createSurface.catalogId = "invalid.catalog";
    await route.fulfill({ response, json: payload });
  });
  await fallback.goto(preview.url + "/chat");
  if (!await fallback.getByRole("button", { name: /Compare two terms/ }).isVisible()) await fallback.getByText("Explore suggested questions", { exact: true }).click();
  await fallback.getByRole("button", { name: /Compare two terms/ }).click();
  await fallback.locator('[data-renderer="fallback"]').waitFor();
  await fallback.getByRole("heading", { name: "Compare balance definitions" }).waitFor();
  await fallback.getByText("For illustration.", { exact: true }).waitFor();
  await fallback.getByLabel("Your question").fill("Show my home-buying goal.");
  await fallback.getByLabel("Your question").press("Enter");
  await fallback.locator('[data-renderer="fallback"]').getByRole("img", { name: /Down payment savings/ }).waitFor();

  const signInContext = await browser.newContext({ httpCredentials: { ...operatorCredentials, origin: preview.url }, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const signInPage = await signInContext.newPage();
  signInPage.on("pageerror", (error) => pageErrors.push(error.message));
  await signInPage.goto(preview.url + "/chat");
  await signInPage.getByRole("link", { name: "Sign in", exact: true }).click();
  const signIn = signInPage.getByRole("heading", { name: "Sign in", exact: true });
  await signIn.waitFor();
  assert.equal(new URL(signInPage.url()).pathname, "/login");
  const accounts = signInPage.getByRole("list", { name: "Available profiles", exact: true });
  await accounts.waitFor();
  assert.deepEqual(await accounts.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))), [
    "Sign in as Alice Morgan", "Sign in as Jordan Lee", "Sign in as Marcus Reed",
  ]);
  await signInPage.screenshot({ path: resolve(screenshots, "sign-in-desktop.png") });

  const signInAs = (name: string) => accounts.getByRole("button", { name: "Sign in as " + name, exact: true }).click();
  const currentProfile = (name: string) => signInPage.getByRole("button", { name: "Profiles, current profile " + name, exact: true });
  const history = signInPage.getByRole("navigation", { name: "Recent conversations", exact: true });
  const signOut = signInPage.getByRole("button", { name: "Sign out", exact: true });
  const askAsProfile = async (prompt: string) => {
    await signInPage.getByLabel("Your question", { exact: true }).fill(prompt);
    await signInPage.getByRole("button", { name: "Send message", exact: true }).click();
  };
  const portfolioPrompt = "Let me know my portfolio summary.";
  const jordanCash = signInPage.locator('[data-renderer="a2ui"]').getByRole("region", { name: "Portfolio snapshot", exact: true })
    .getByText("$10,000", { exact: true });
  const welcomePortfolio = signInPage.getByRole("region", { name: "Account summary", exact: true });
  const pendingActions = signInPage.getByRole("region", { name: "Pending actions", exact: true });
  await signInAs("Jordan Lee");
  await currentProfile("Jordan Lee").waitFor();
  await welcomePortfolio.getByText("$10,000", { exact: true }).waitFor();
  await welcomePortfolio.getByText("Value history", { exact: true }).click();
  await welcomePortfolio.getByRole("button", { name: "3 months", exact: true }).click();
  await welcomePortfolio.getByRole("img", { name: /Portfolio value from/ }).waitFor();
  await welcomePortfolio.getByText("Value history", { exact: true }).click();
  await pendingActions.getByText("No pending actions.", { exact: true }).waitFor();
  await welcomePortfolio.getByRole("button", { name: "Ask about portfolio", exact: true }).click();
  await jordanCash.waitFor();
  await signInPage.reload();
  await currentProfile("Jordan Lee").waitFor();
  await jordanCash.waitFor();
  assert.equal(await signInPage.locator(".assistant-message[data-live-reply]").count(), 0);
  await signInPage.getByRole("button", { name: "New conversation", exact: true }).click();
  await signInPage.getByRole("heading", { name: "New conversation", exact: true, level: 1 }).waitFor();
  await welcomePortfolio.getByText("$10,000", { exact: true }).waitFor();
  await pendingActions.getByText("No pending actions.", { exact: true }).waitFor();
  assert.equal(await signInPage.getByRole("main").getByRole("complementary").count(), 0);
  assert.equal(await signInPage.getByRole("button", { name: "Details", exact: true }).count(), 0);

  await signOut.click();
  await signIn.waitFor();
  await signInPage.goto(preview.url + "/chat");
  await signIn.waitFor();
  assert.equal(new URL(signInPage.url()).pathname, "/login");
  await signInAs("Marcus Reed");
  await currentProfile("Marcus Reed").waitFor();
  assert.doesNotMatch(await history.innerText(), /portfolio summary/i);
  await welcomePortfolio.getByText("$0", { exact: true }).first().waitFor();
  await pendingActions.getByRole("heading", { name: "Fund your account", exact: true }).waitFor();
  await pendingActions.getByRole("button", { name: "Preview funding", exact: true }).click();
  const signedInResponse = signInPage.locator('[data-renderer="a2ui"]');
  await signedInResponse.getByRole("region", { name: "Funding options", exact: true }).waitFor();
  await askAsProfile("Use the linked bank account.");
  await signedInResponse.getByRole("region", { name: "Funding preview", exact: true }).waitFor();

  await signedInResponse.getByRole("region", { name: "Funding preview" }).getByRole("link", { name: "Open account portal" }).click();
  await signInPage.getByRole("button", { name: "Mark account funded" }).click();
  await signInPage.getByRole("status").getByText("Account funded", { exact: true }).waitFor();
  await signOut.click();
  await signInAs("Marcus Reed");
  await pendingActions.getByText("First deposit confirmed", { exact: true }).waitFor();
  await pendingActions.getByText("No pending actions.", { exact: true }).waitFor();
  assert.equal(await pendingActions.getByRole("button", { name: "Preview funding" }).count(), 0);
  await askAsProfile("what is next");
  await signedInResponse.getByRole("heading", { name: "Your first deposit is on file" }).waitFor();

  await signOut.click();
  await signInAs("Alice Morgan");
  await currentProfile("Alice Morgan").waitFor();
  assert.match(await history.innerText(), /New conversations appear here/);
  await welcomePortfolio.getByText("$12,500", { exact: true }).waitFor();
  const pendingGuide = pendingActions.getByRole("button", { name: "See beneficiary update steps", exact: true });
  await pendingGuide.waitFor();
  const loginLogs = await signInContext.newPage();
  await loginLogs.goto(preview.url + adminPaths.logs);
  await loginLogs.getByRole("link", { name: "Pending actions", exact: true }).click();
  const details = loginLogs.getByRole("region", { name: "Pending action call details" });
  const lookup = loginLogs.getByLabel("Pending action lookup", { exact: true });
  for (const [name, mid, ids] of [
    ["Alice Morgan", "DEMO-MID-1001", ["beneficiary_update"]],
    ["Marcus Reed", "DEMO-MID-1003", []],
    ["Jordan Lee", "DEMO-MID-1002", []],
  ] as const) {
    const option = lookup.locator("option").filter({ hasText: name }).first();
    await option.waitFor({ state: "attached" });
    await lookup.selectOption(await option.getAttribute("value") ?? "");
    assert.deepEqual(JSON.parse(await details.getByLabel("Treatment Selector request").innerText()), { mid, context: pendingActionsContext });
    const response = JSON.parse(await details.getByLabel("Treatment Selector response").innerText());
    assert.deepEqual(response.recommendations.map(({ id }: { id: string }) => id), ids);
    if (name === "Marcus Reed") await details.getByRole("heading", { name: "Funding reminder excluded" }).waitFor();
  }
  await loginLogs.close();
  await pendingGuide.click();
  await signedInResponse.getByRole("heading", { name: "Update your beneficiaries", exact: true }).waitFor();
  await signOut.click();
  await signInAs("Jordan Lee");
  await signInPage.getByRole("heading", { name: "Welcome, Jordan.", exact: true }).waitFor();
  await history.getByRole("button", { name: portfolioPrompt, exact: true }).click();
  await jordanCash.waitFor();
  assert.doesNotMatch(await history.innerText(), /preview funding|beneficiaries/i);

  await openAdmin(signInPage, "tools");
  await signInPage.getByLabel("Demo profile", { exact: true }).selectOption("demo-new-account");
  await signInPage.getByRole("button", { name: "Open in chat", exact: true }).click();
  await currentProfile("Marcus Reed").waitFor();
  assert.doesNotMatch(await history.innerText(), /portfolio summary/i);
  await openCustomerChat(signInPage);
  await currentProfile("Jordan Lee").waitFor();
  await jordanCash.waitFor();

  const mobileSignIn = await browser.newPage({ httpCredentials: { ...operatorCredentials, origin: preview.url }, viewport: { width: 360, height: 780 }, reducedMotion: "reduce" });
  await mobileSignIn.goto(preview.url + "/login");
  await mobileSignIn.getByRole("button", { name: "Sign in as Marcus Reed", exact: true }).waitFor();
  assert.equal(await mobileSignIn.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobileSignIn.screenshot({ path: resolve(screenshots, "sign-in-mobile.png") });
  await mobileSignIn.getByRole("button", { name: "Sign in as Alice Morgan", exact: true }).click();
  await mobileSignIn.getByRole("region", { name: "Account summary", exact: true }).waitFor();
  await mobileSignIn.getByRole("region", { name: "Pending actions", exact: true }).waitFor();
  assert.equal(await mobileSignIn.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(pageErrors, []);
  console.log("Browser checks passed for profile sign-in, the chat homepage, Help, personalization, logs, tool setup, and renderer fallback.");
} finally {
  await browser?.close();
  await preview.close();
}
