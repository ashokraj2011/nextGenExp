import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./http";
import { agenticBudgetFromEnv } from "./agentic-budget";
import { gatewayFromEnv } from "./gateway";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const useOpenAi = process.argv.includes("--openai");
const mode = process.env.PZN_SELECTION_MODE ?? "semantic_rerank";
if (mode !== "semantic_rerank" && mode !== "preserve_ts_rank") throw new Error("PZN_SELECTION_MODE is invalid.");
const gateway = gatewayFromEnv(process.env, useOpenAi ? "openai" : "gateway");
const profile = gateway?.profile;
const port = Number(process.env.PZN_PORT ?? (profile === "openai" ? 4175 : 4173));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PZN_PORT is invalid.");
const defaultDataDir = profile === "openai" ? ".pzn-data/openai" : profile === "copilot_acp" ? ".pzn-data/copilot" : ".pzn-data";
const app = await startApp({
  projectRoot, dataDir: resolve(projectRoot, process.env.PZN_DATA_DIR ?? defaultDataDir), gateway,
  selectionMode: mode, port, goalBudget: agenticBudgetFromEnv(process.env.PZN_AXE_BUDGET_JSON), dev: process.argv.includes("--dev"), inspectorEnabled: process.env.PZN_INSPECTOR !== "off",
});
console.log("Financial planning demo  " + app.url);
if (gateway?.profile === "openai") console.log("OpenAI API model " + gateway.model);
if (gateway?.profile === "copilot_acp") console.log("Copilot ACP model " + gateway.model);
if (!gateway) console.log("Gateway setup required. Set LLM_BASE_URL, LLM_MODEL, and LLM_API_KEY or LLM_GATEWAY_HEADERS_JSON in the server environment.");
let closing = false;
for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.once(event, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  });
}
