import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tenantDataDirectory } from "./tenant";
import { startApp } from "./http";
import { agenticBudgetFromEnv } from "./agentic-budget";
import { gatewayFromEnv } from "./gateway";
import { GatewayConfigStore, settingsFromConfig } from "./gateway-config";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const useOpenAi = process.argv.includes("--openai");
const preview = process.argv.includes("--preview");
const mode = process.env.PZN_SELECTION_MODE ?? "semantic_rerank";
if (mode !== "semantic_rerank" && mode !== "preserve_ts_rank") throw new Error("PZN_SELECTION_MODE is invalid.");
const envGateway = gatewayFromEnv(process.env, useOpenAi ? "openai" : "gateway");
const envProfile = envGateway?.profile;
const port = Number(process.env.PZN_PORT ?? (preview ? 4174 : envProfile === "openai" ? 4175 : 4173));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PZN_PORT is invalid.");
// The data directory follows the launch environment, so a gateway activated in the admin UI keeps the same data.
const defaultDataDir = envProfile === "openai" ? ".pzn-data/openai" : envProfile === "copilot_acp" ? ".pzn-data/copilot" : ".pzn-data";
const dataDir = resolve(projectRoot, process.env.PZN_DATA_DIR ?? (preview ? ".pzn-data/preview" : defaultDataDir));
const gatewayConfig = new GatewayConfigStore(tenantDataDirectory(dataDir));

/** A gateway activated in Administration → Model gateway wins over environment variables. */
function resolveGateway() {
  const saved = gatewayConfig.active();
  if (saved) {
    try {
      return { gateway: settingsFromConfig(saved), source: `saved (${saved.label || saved.provider}, activated by ${saved.activatedBy})` };
    } catch (err) {
      console.error("Saved gateway configuration is unusable, falling back to environment: " + (err instanceof Error ? err.message : String(err)));
    }
  }
  return { gateway: envGateway, source: "environment" };
}

let restarting: Promise<void> | null = null;
async function start() {
  const { gateway, source } = resolveGateway();
  const app = await startApp({
    projectRoot, dataDir, gateway,
    operators: process.env.PZN_OPERATORS_JSON ? JSON.parse(process.env.PZN_OPERATORS_JSON) : undefined,
    operatorAuth: process.env.PZN_OPERATOR_AUTH === "off" ? "off" : "on",
    onGatewayActivated: () => { void restart(); },
    selectionMode: mode as "semantic_rerank" | "preserve_ts_rank", port, goalBudget: agenticBudgetFromEnv(process.env.PZN_AXE_BUDGET_JSON), dev: process.argv.includes("--dev"), inspectorEnabled: process.env.PZN_INSPECTOR !== "off",
  });
  console.log("Financial planning demo  " + app.url);
  if (process.env.PZN_OPERATOR_AUTH === "off") console.log("Operator sign-in is OFF (local demo): admin pages act as local-operator. Remove PZN_OPERATOR_AUTH to require sign-in.");
  if (gateway?.profile === "openai") console.log("OpenAI API model " + gateway.model + " · gateway: " + source);
  else if (gateway?.profile === "copilot_acp") console.log("Copilot ACP model " + gateway.model + " · gateway: " + source);
  else if (gateway) console.log("Gateway model " + gateway.model + " at " + gateway.baseUrl + " · gateway: " + source);
  else console.log("Gateway setup required. Configure it in Administration → Model gateway, or set LLM_BASE_URL, LLM_MODEL, and LLM_API_KEY or LLM_GATEWAY_HEADERS_JSON.");
  return app;
}

let app = await start();
/** In-process restart so sfield re-binds the model; pending approvals and scopes resume after restarts. */
function restart() {
  restarting ??= (async () => {
    console.log("Activating the new model gateway: restarting the app…");
    try {
      await app.close();
      app = await start();
    } catch (err) {
      console.error("Restart with the new gateway failed; reverting to the environment gateway: " + (err instanceof Error ? err.message : String(err)));
      gatewayConfig.reset();
      app = await start();
    } finally {
      restarting = null;
    }
  })();
  return restarting;
}
let closing = false;
for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.once(event, () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  });
}
