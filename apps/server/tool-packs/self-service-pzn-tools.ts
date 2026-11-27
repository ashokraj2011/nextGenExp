/**
 * Self-Service Personalization Studio tool pack for sfield.
 *
 * Keeps Data Dictionary, Rule Metadata, and live Treatment Selector evaluation tools
 * isolated from the core Runtime bootstrapper so non-TS domains can omit this pack cleanly.
 */
import { defineTool, ToolError } from "@sfield/core";
import {
  pznDataDictionaryToolId,
  pznDataDictionaryToolInputJsonSchema,
  pznGenericToolResultJsonSchema,
  pznRuleMetadataToolId,
  pznRuleMetadataToolInputJsonSchema,
  pznSfieldToolVersion,
  pznTreatmentSelectorToolId,
  pznTreatmentSelectorToolInputJsonSchema,
} from "../../../packages/contracts/self-service-pzn";
import type { SelfServicePznStore } from "../self-service-pzn-store";

export interface SelfServicePznToolPackDeps {
  selfServicePzn?: SelfServicePznStore;
  parsePayload: (operation: string, payloadJson?: string) => Record<string, unknown>;
}

export function createSelfServicePznToolPack(deps: SelfServicePznToolPackDeps) {
  return [
    defineTool({
      id: pznDataDictionaryToolId,
      version: pznSfieldToolVersion,
      description: "Data Dictionary API registered with sfield: read and author governed namespaces, attributes, business definitions, operators, and live resolver paths.",
      resource: { type: "pzn_data_dictionary", id: { ref: "inputs.operation" } },
      inputs: pznDataDictionaryToolInputJsonSchema,
      outputs: pznGenericToolResultJsonSchema,
      policy: {
        action: pznDataDictionaryToolId,
        effect: "write",
        requiresApproval: false,
        maxAttempts: 1,
        timeoutMs: 5_000,
        classification: "public",
        maxOutputBytes: 48_000,
      },
      handler: async (raw) => {
        if (!deps.selfServicePzn) throw new ToolError("PZN_STORE_UNAVAILABLE", "Self-service PZN store is not attached.");
        const inp = raw as { operation: string; payloadJson?: string };
        const payload = deps.parsePayload(inp.operation, inp.payloadJson);
        try {
          switch (inp.operation) {
            case "get_dictionary": {
              const dict = deps.selfServicePzn.getDictionary();
              return { ok: true, operation: inp.operation, summary: `Read Data Dictionary (${dict.namespaces.length} namespaces)`, resultJson: JSON.stringify(dict) };
            }
            case "upsert_namespace": {
              const ns = deps.selfServicePzn.upsertNamespace(payload);
              return { ok: true, operation: inp.operation, summary: `Saved namespace "${ns.id}" (${ns.displayName})`, resultJson: JSON.stringify(ns) };
            }
            case "delete_namespace": {
              deps.selfServicePzn.deleteNamespace(String(payload.id ?? ""));
              return { ok: true, operation: inp.operation, summary: `Deleted namespace "${String(payload.id ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
            }
            case "upsert_attribute": {
              const attr = deps.selfServicePzn.upsertAttribute(payload);
              return { ok: true, operation: inp.operation, summary: `Saved Data Dictionary attribute "${attr.namespaceId}.${attr.id}"`, resultJson: JSON.stringify(attr) };
            }
            case "delete_attribute": {
              deps.selfServicePzn.deleteAttribute(String(payload.namespaceId ?? ""), String(payload.attributeId ?? ""));
              return { ok: true, operation: inp.operation, summary: `Deleted attribute "${String(payload.namespaceId ?? "")}.${String(payload.attributeId ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
            }
            default:
              throw new ToolError("INVALID_OPERATION", `Unsupported Data Dictionary operation: ${inp.operation}`);
          }
        } catch (err) {
          if (err instanceof ToolError) throw err;
          throw new ToolError("PZN_DICTIONARY_ERROR", err instanceof Error ? err.message : "Data Dictionary tool error");
        }
      },
    }),
    defineTool({
      id: pznRuleMetadataToolId,
      version: pznSfieldToolVersion,
      description: "Rule Metadata API registered with sfield: create/update/test Data Dictionary rules, text contents, contexts, content-rule attachments, and immutable publish snapshots.",
      resource: { type: "pzn_rule_metadata", id: { ref: "inputs.operation" } },
      inputs: pznRuleMetadataToolInputJsonSchema,
      outputs: pznGenericToolResultJsonSchema,
      policy: {
        action: pznRuleMetadataToolId,
        effect: "write",
        requiresApproval: false,
        maxAttempts: 1,
        timeoutMs: 5_000,
        classification: "public",
        maxOutputBytes: 48_000,
      },
      handler: async (raw) => {
        if (!deps.selfServicePzn) throw new ToolError("PZN_STORE_UNAVAILABLE", "Self-service PZN store is not attached.");
        const inp = raw as { operation: string; payloadJson?: string };
        const payload = deps.parsePayload(inp.operation, inp.payloadJson);
        try {
          switch (inp.operation) {
            case "get_workspace": {
              const ws = deps.selfServicePzn.getWorkspaceState();
              return { ok: true, operation: inp.operation, summary: `Loaded workspace (${ws.contexts.length} contexts, ${ws.rules.length} rules)`, resultJson: JSON.stringify(ws) };
            }
            case "list_rules": {
              const rules = deps.selfServicePzn.listRules();
              return { ok: true, operation: inp.operation, summary: `Listed ${rules.length} governed rules`, resultJson: JSON.stringify(rules) };
            }
            case "upsert_rule": {
              const rule = deps.selfServicePzn.upsertRule(payload);
              return { ok: true, operation: inp.operation, summary: `Saved rule "${rule.ruleId}" (${rule.name})`, resultJson: JSON.stringify(rule) };
            }
            case "delete_rule": {
              deps.selfServicePzn.deleteRule(String(payload.ruleId ?? ""));
              return { ok: true, operation: inp.operation, summary: `Deleted rule "${String(payload.ruleId ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
            }
            case "test_rule": {
              const testRes = deps.selfServicePzn.testRule(payload);
              return { ok: true, operation: inp.operation, summary: `Tested rule on ${testRes.mid} → ${testRes.evaluation.matched ? "TRUE" : "FALSE"}`, resultJson: JSON.stringify(testRes) };
            }
            case "list_contents": {
              const contents = deps.selfServicePzn.listContents();
              return { ok: true, operation: inp.operation, summary: `Listed ${contents.length} text contents`, resultJson: JSON.stringify(contents) };
            }
            case "upsert_content": {
              const content = deps.selfServicePzn.upsertContent(payload);
              return { ok: true, operation: inp.operation, summary: `Saved text content "${content.contentId}" (${content.title})`, resultJson: JSON.stringify(content) };
            }
            case "delete_content": {
              deps.selfServicePzn.deleteContent(String(payload.contentId ?? ""));
              return { ok: true, operation: inp.operation, summary: `Deleted text content "${String(payload.contentId ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
            }
            case "list_contexts": {
              const contexts = deps.selfServicePzn.listContexts();
              return { ok: true, operation: inp.operation, summary: `Listed ${contexts.length} contexts`, resultJson: JSON.stringify(contexts) };
            }
            case "upsert_context": {
              const ctx = deps.selfServicePzn.upsertContext(payload);
              return { ok: true, operation: inp.operation, summary: `Saved context "${ctx.contextId}" (${ctx.attachments.length} attachments)`, resultJson: JSON.stringify(ctx) };
            }
            case "delete_context": {
              deps.selfServicePzn.deleteContext(String(payload.contextId ?? ""));
              return { ok: true, operation: inp.operation, summary: `Deleted context "${String(payload.contextId ?? "")}"`, resultJson: JSON.stringify({ deleted: true }) };
            }
            case "publish_context": {
              const pub = deps.selfServicePzn.publishContext(
                String(payload.contextId ?? ""),
                typeof payload.publishedBy === "string" ? payload.publishedBy : "Self-Service Studio",
                typeof payload.notes === "string" ? payload.notes : "",
              );
              return { ok: true, operation: inp.operation, summary: `Published "${pub.contextId}" v${pub.version} to Treatment Selector`, resultJson: JSON.stringify(pub) };
            }
            case "unpublish_context": {
              const ctx = deps.selfServicePzn.unpublishContext(String(payload.contextId ?? ""));
              return { ok: true, operation: inp.operation, summary: `Unpublished "${ctx.contextId}"`, resultJson: JSON.stringify(ctx) };
            }
            default:
              throw new ToolError("INVALID_OPERATION", `Unsupported Rule Metadata operation: ${inp.operation}`);
          }
        } catch (err) {
          if (err instanceof ToolError) throw err;
          throw new ToolError("PZN_RULE_METADATA_ERROR", err instanceof Error ? err.message : "Rule Metadata tool error");
        }
      },
    }),
    defineTool({
      id: pznTreatmentSelectorToolId,
      version: pznSfieldToolVersion,
      description: "Treatment Selector (TS) API registered with sfield: evaluates a Customer MID + published Context, hydrates Data Dictionary attributes, calls the Rule Engine, filters contents, and returns eligible recommendations.",
      inputs: pznTreatmentSelectorToolInputJsonSchema,
      outputs: pznGenericToolResultJsonSchema,
      policy: {
        action: pznTreatmentSelectorToolId,
        effect: "read",
        requiresApproval: false,
        maxAttempts: 1,
        timeoutMs: 5_000,
        classification: "public",
        maxOutputBytes: 48_000,
      },
      handler: async (raw) => {
        if (!deps.selfServicePzn) throw new ToolError("PZN_STORE_UNAVAILABLE", "Self-service PZN store is not attached.");
        const inp = raw as { operation: string; payloadJson?: string };
        const payload = deps.parsePayload(inp.operation, inp.payloadJson);
        try {
          switch (inp.operation) {
            case "evaluate": {
              const evalRes = deps.selfServicePzn.evaluateLiveTs(payload as Parameters<SelfServicePznStore["evaluateLiveTs"]>[0]);
              return {
                ok: true,
                operation: inp.operation,
                summary: `TS(${evalRes.mid}, ${evalRes.contextId}) → ${evalRes.eligibleContents.length} eligible, ${evalRes.filteredOutContents.length} filtered out (${evalRes.durationMs}ms)`,
                resultJson: JSON.stringify(evalRes),
              };
            }
            case "list_published_contexts": {
              const list = deps.selfServicePzn.listPublishedContextSummaries();
              return { ok: true, operation: inp.operation, summary: `Listed ${list.length} published contexts`, resultJson: JSON.stringify(list) };
            }
            default:
              throw new ToolError("INVALID_OPERATION", `Unsupported Treatment Selector operation: ${inp.operation}`);
          }
        } catch (err) {
          if (err instanceof ToolError) throw err;
          throw new ToolError("PZN_TS_ERROR", err instanceof Error ? err.message : "Treatment Selector tool error");
        }
      },
    }),
  ];
}
