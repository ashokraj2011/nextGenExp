// Standalone HITL Approval example: write tool pauses with APPROVAL_REQUIRED, operator approves, call resumes
import { SField, SFieldError, defineTool } from "@sfield/core";

const transferTool = defineTool({
  id: "ledger.transfer",
  version: "1.0.0",
  description: "Execute a governed fund transfer (requires human approval in supervised preset).",
  inputs: {
    type: "object",
    properties: {
      accountId: { type: "string" },
      amountCents: { type: "integer", minimum: 1 },
    },
    required: ["accountId", "amountCents"],
    additionalProperties: false,
  },
  outputs: {
    type: "object",
    properties: { transferred: { type: "boolean" }, receiptId: { type: "string" } },
    required: ["transferred", "receiptId"],
    additionalProperties: false,
  },
  policy: { effect: "write", classification: "confidential", requiresApproval: true },
  resource: { type: "account", id: { ref: "inputs.accountId" } },
  handler: async ({ accountId, amountCents }) => ({
    transferred: true,
    receiptId: `tx_${accountId}_${amountCents}`,
  }),
});

const sf = await SField.create({
  config: { version: 1, models: {}, agents: {} },
  preset: "memory",
  tools: [transferTool],
  limits: { grants: { effects: ["read", "write"] } },
  quiet: true,
});

const scope = await sf.executions.open({ purpose: "hitl-demo", preset: "supervised" });

// 1. First call pauses by throwing SFieldError("APPROVAL_REQUIRED") with digest-bound approvalId & callId
let approvalId;
let callId;
try {
  await scope.registry.execute("ledger.transfer@1.0.0", { accountId: "acct-42", amountCents: 25000 });
} catch (err) {
  if (!SFieldError.is(err, "APPROVAL_REQUIRED")) throw err;
  approvalId = err.details.approvalId;
  callId = err.details.callId;
  console.log("Step 1 (paused):", err.code, { approvalId, callId });
}

// 2. Operator approves
await sf.approvals.decide({
  approvalId,
  actor: { tenantId: sf.devPrincipal.tenantId, subjectId: "compliance-officer" },
  decision: "approve",
  comment: "Verified transfer limit",
});

// 3. Resume the exact callId — executes and consumes the single-use approval
const resumed = await scope.registry.execute(
  "ledger.transfer@1.0.0",
  { accountId: "acct-42", amountCents: 25000 },
  { callId },
);
console.log("Step 2 (resumed):", resumed.status, resumed.output);

await scope.close();
await sf.close();
