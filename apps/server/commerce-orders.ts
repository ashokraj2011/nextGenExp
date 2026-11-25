import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { TaskContractInput } from "../../packages/contracts/integration-task";

const rowSchema = z.object({ orderId: z.string(), memberId: z.string(), status: z.string(), total: z.number().nonnegative() });
const samples = [
  { orderId: "ORD-1001", memberId: "DEMO-MID-1001", status: "shipped", total: 129.50 },
  { orderId: "ORD-1002", memberId: "DEMO-MID-1002", status: "processing", total: 42 },
];

export function orderSource(dataDir: string) {
  const path = join(dataDir, "commerce-orders.json");
  mkdirSync(dataDir, { recursive: true });
  try { writeFileSync(path, JSON.stringify(samples, null, 2), { flag: "wx", mode: 0o600 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  return (id: unknown, member: unknown) => z.array(rowSchema).parse(JSON.parse(readFileSync(path, "utf8")))
    .find((r) => r.orderId === id && r.memberId === member);
}

export const customerOrderTask: TaskContractInput = {
  integrationId: "commerce_sandbox", taskId: "lookup_order", version: "1.0.0", description: "Check the signed-in customer’s order status.", effect: "read",
  inputSchema: { type: "object", additionalProperties: false, required: ["orderId", "memberId"], properties: { orderId: { type: "string" }, memberId: { type: "string" } } },
  outputSchema: { type: "object", additionalProperties: false, required: ["found"], properties: {
    found: { type: "boolean" }, orderId: { type: "string" }, memberId: { type: "string" }, status: { type: "string" }, total: { type: "number" },
  } },
  outcomeCodes: [{ code: "FOUND", meaning: "Order found", success: true }, { code: "NOT_FOUND", meaning: "Order unavailable", success: false }],
  outcomeMapping: [{ statusIn: [200], field: "found", equals: true, code: "FOUND" }, { statusIn: [200], field: "found", equals: false, code: "NOT_FOUND" }],
  approvalPolicy: { mode: "none" }, idempotency: { supported: false }, resourceIdField: "orderId", binding: { target: "commerce.lookup_order", method: "GET" },
  customerExperience: { topic: "order", idPrefix: "ORD", memberField: "memberId", fields: [{ key: "status", label: "Delivery status" }, { key: "total", label: "Order total (USD)" }], watch: { field: "status", value: "delivered" } },
};
