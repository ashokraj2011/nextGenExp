import { tenantDataDirectory } from "../apps/server/tenant";
import { startTestPreview } from "./preview";

const port = process.env.PZN_TEST_PORT ? Number(process.env.PZN_TEST_PORT) : 4174;
const operators = process.env.PZN_OPERATORS_JSON ? JSON.parse(process.env.PZN_OPERATORS_JSON) : null;
const preview = await startTestPreview(port, () => ({ delayMs: 210 }), operators);
console.log("Financial planning demo · Automated test preview  " + preview.url);
if (!operators) console.log("Operator sign-in file: " + tenantDataDirectory(preview.dataDir) + "/operator-credentials.json");
let closing = false;
for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.once(event, () => {
    if (closing) return;
    closing = true;
    void preview.close().catch(() => { process.exitCode = 1; });
  });
}
