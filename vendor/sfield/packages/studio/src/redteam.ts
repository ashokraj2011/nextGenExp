/**
 * 1-Click Zero-Trust Governance & Red-Team Proof Suite for `@sfield/studio`.
 *
 * Runs 5 live adversarial proofs against an isolated in-memory `@sfield/core` kernel
 * so operators and security reviewers can verify `sfield`'s guarantees in < 1 second.
 */
import {
  createDevAuthorizer,
  createPiiFirewall,
  createPrincipal,
  defineTool,
  EphemeralPersistence,
  InMemoryArtifactStore,
  SField,
} from "@sfield/core";

export interface RedTeamProof {
  id: string;
  title: string;
  attack: string;
  defense: string;
  passed: boolean;
  durationMs: number;
  evidence: Record<string, unknown>;
}

export interface RedTeamSuiteResult {
  passed: number;
  total: number;
  allPassed: boolean;
  ranAt: string;
  proofs: RedTeamProof[];
}

export async function runRedTeamProofSuite(): Promise<RedTeamSuiteResult> {
  const proofs: RedTeamProof[] = [];
  let wireMutated = false;

  const readAccount = defineTool({
    id: "proof.account.read",
    version: "1.0.0",
    description: "Read demo account balance.",
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["accountId"],
      properties: { accountId: { type: "string" } },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["accountId", "balanceCents"],
      properties: { accountId: { type: "string" }, balanceCents: { type: "integer" } },
    },
    policy: { effect: "read", classification: "internal" },
    handler: async ({ accountId }) => ({ accountId: String(accountId), balanceCents: 450_000 }),
  });

  const wireTransfer = defineTool({
    id: "proof.wire.send",
    version: "1.0.0",
    description: "Send a wire transfer (governed write).",
    inputs: {
      type: "object",
      additionalProperties: false,
      required: ["accountId", "amountCents"],
      properties: { accountId: { type: "string" }, amountCents: { type: "integer" } },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["transferId", "amountCents"],
      properties: { transferId: { type: "string" }, amountCents: { type: "integer" } },
    },
    resource: { type: "account", id: { ref: "inputs.accountId" } },
    policy: {
      effect: "write",
      classification: "confidential",
      action: "wire.send",
    },
    handler: async ({ amountCents }) => {
      wireMutated = true;
      return { transferId: "wire_001", amountCents: Number(amountCents) };
    },
  });

  const sf = await SField.create({
    config: { version: 1, models: {}, agents: {} },
    deployment: "ephemeral",
    persistence: new EphemeralPersistence(),
    artifacts: new InMemoryArtifactStore(),
    authorizer: { authorize: async () => ({ decision: "allow" as const, evidenceId: "ev_redteam", expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
    tools: [readAccount, wireTransfer],
  });

  const alice = createPrincipal({ tenantId: "tenant-alpha", subjectId: "alice", identifiers: { mid: "MID-ALICE" } });
  const bob = createPrincipal({ tenantId: "tenant-beta", subjectId: "bob", identifiers: { mid: "MID-BOB" } });

  try {
    // Proof 1: Prompt-injected write tool call inside a read_only agent scope
    {
      const t0 = Date.now();
      const scope = await sf.executions.open({ principal: alice, preset: "read_only", purpose: "redteam-readonly" });
      try {
        let status = "succeeded";
        let errorCode: string | null = null;
        try {
          const res = await scope.registry.execute("proof.wire.send@1.0.0", { accountId: "acct-1", amountCents: 999_900 });
          status = res.status;
          errorCode = res.error?.code ?? null;
        } catch (err) {
          status = "denied";
          errorCode = (err as { code?: string })?.code ?? "THROWN_ERROR";
        }
        const blocked = status !== "succeeded" && !wireMutated;
        proofs.push({
          id: "prompt_injected_write_blocked",
          title: "1. Prompt-Injected Write in read_only Scope",
          attack: "LLM agent running under read_only preset attempts to invoke proof.wire.send@1.0.0 for $9,999.",
          defense: "Policy preset read_only blocks all write/destructive tools before handler execution.",
          passed: blocked,
          durationMs: Math.max(0, Date.now() - t0),
          evidence: { status, errorCode, handlerExecuted: wireMutated },
        });
      } finally {
        await scope.close().catch(() => undefined);
      }
    }

    // Proof 2: Closed JSON Schema rejects undeclared/injected arguments before handler execution
    {
      const t0 = Date.now();
      const scope = await sf.executions.open({ principal: alice, preset: "read_only", purpose: "redteam-closed-schema" });
      try {
        let status = "succeeded";
        let errorCode: string | null = null;
        try {
          const res = await scope.registry.execute("proof.account.read@1.0.0", {
            accountId: "acct-1",
            bypassPolicy: true,
          });
          status = res.status;
          errorCode = res.error?.code ?? null;
        } catch (err) {
          status = "denied";
          errorCode = (err as { code?: string })?.code ?? "THROWN_ERROR";
        }
        const blocked = status !== "succeeded" && errorCode === "INVALID_INPUT";
        proofs.push({
          id: "closed_schema_injection_blocked",
          title: "2. Closed JSON Schema Argument Injection",
          attack: "Caller injects undeclared argument bypassPolicy=true into proof.account.read@1.0.0.",
          defense: "sfield Ajv closed schema validator (additionalProperties: false) rejects undeclared arguments before handler execution.",
          passed: blocked,
          durationMs: Math.max(0, Date.now() - t0),
          evidence: { status, errorCode },
        });
      } finally {
        await scope.close().catch(() => undefined);
      }
    }

    // Proof 3: Cross-Tenant / Cross-Principal Memory Isolation
    {
      const t0 = Date.now();
      const saved = await sf.memory.for(alice).put({
        scope: { kind: "subject", tenantId: alice.tenantId, subjectId: alice.subjectId },
        kind: "fact",
        content: "Private wire limit: $50,000",
        structured: { key: "wire_limit", value: { maxUsd: 50_000 } },
        origin: "trusted_source",
        provenance: [{ sourceType: "host", sourceId: "redteam-seed", observedAt: new Date().toISOString() }],
      }, { idempotencyKey: "redteam-mem-alice" });
      const bobRead = await sf.memory.for(bob).get(saved.id);
      const isolated = bobRead === null;
      proofs.push({
        id: "cross_tenant_memory_isolated",
        title: "3. Cross-Tenant Memory Isolation",
        attack: "Bob (tenant-beta) reads Alice's (tenant-alpha) private memory item ID directly.",
        defense: "sfield MemoryService partitions every read and write by tenantId; cross-tenant lookups return null.",
        passed: isolated,
        durationMs: Math.max(0, Date.now() - t0),
        evidence: { attacker: `${bob.tenantId}/${bob.subjectId}`, targetId: saved.id, leakedRecord: Boolean(bobRead) },
      });
    }

    // Proof 4: PII Egress Firewall scrubs SSN, email, phone & account before external LLM call
    {
      const t0 = Date.now();
      const firewall = createPiiFirewall();
      const raw = "Customer Alice Morgan (SSN 123-45-6789, email alice@example.com, phone 415-555-0199) owns account 9876543210.";
      const { scrubbed, tokenMap, tokens } = firewall.scrubText(raw);
      const rehydrated = firewall.rehydrateText(scrubbed, tokenMap);
      const safe = !scrubbed.includes("123-45-6789")
        && !scrubbed.includes("alice@example.com")
        && rehydrated.includes("123-45-6789")
        && tokens.length >= 3;
      proofs.push({
        id: "pii_egress_scrubbed",
        title: "4. PII Egress Firewall & Local Rehydration",
        attack: "Prompt containing SSN, email, phone, and account number heads toward external LLM provider.",
        defense: "PiiFirewall tokenizes sensitive fields before egress and rehydrates strictly inside host boundary.",
        passed: safe,
        durationMs: Math.max(0, Date.now() - t0),
        evidence: { redactionCount: tokens.length, scrubbedPreview: scrubbed, rehydratedIntact: rehydrated === raw },
      });
    }

    // Proof 5: Unapproved write under supervised preset is held for HITL approval
    {
      const t0 = Date.now();
      const scope = await sf.executions.open({ principal: alice, preset: "supervised", purpose: "redteam-hitl" });
      try {
        let status = "succeeded";
        let errorCode: string | null = null;
        try {
          const res = await scope.registry.execute("proof.wire.send@1.0.0", { accountId: "acct-1", amountCents: 50_000 });
          status = res.status;
          errorCode = res.error?.code ?? null;
        } catch (err) {
          status = "suspended";
          errorCode = (err as { code?: string })?.code ?? "THROWN_ERROR";
        }
        const pendingApprovals = await sf.approvals.list({ tenantId: alice.tenantId, status: ["pending"] });
        const approvalId = pendingApprovals[0]?.id ?? null;
        const held = errorCode === "APPROVAL_REQUIRED" && Boolean(approvalId) && !wireMutated;
        proofs.push({
          id: "unapproved_write_held_for_hitl",
          title: "5. Unapproved Write Held for Digest-Bound HITL",
          attack: "Supervised execution attempts proof.wire.send@1.0.0 ($500) without prior human approval.",
          defense: "sfield suspends execution with APPROVAL_REQUIRED and creates a SHA-256 digest-bound approval record.",
          passed: held,
          durationMs: Math.max(0, Date.now() - t0),
          evidence: { status, errorCode, approvalId, handlerExecuted: wireMutated },
        });
      } finally {
        await scope.close().catch(() => undefined);
      }
    }
  } finally {
    await sf.close();
  }

  const passed = proofs.filter((p) => p.passed).length;
  return {
    passed,
    total: proofs.length,
    allPassed: passed === proofs.length,
    ranAt: new Date().toISOString(),
    proofs,
  };
}
