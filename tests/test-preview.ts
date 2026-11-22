import { startTestPreview } from "./preview";

const port = process.env.PZN_TEST_PORT ? Number(process.env.PZN_TEST_PORT) : 4174;
const preview = await startTestPreview(port, () => ({ delayMs: 210 }));
console.log("Financial planning demo · Automated test preview  " + preview.url);
let closing = false;
for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.once(event, () => {
    if (closing) return;
    closing = true;
    void preview.close().catch(() => { process.exitCode = 1; });
  });
}
