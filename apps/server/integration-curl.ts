/**
 * Deterministic cURL & Sample JSON -> sfield Integration + TaskContract importer.
 * Parses pasted or uploaded cURL commands (single or multi-line), detects method, baseUrl,
 * path parameters, query parameters, auth header secret references (never storing raw secrets),
 * and infers strict closed JSON Schemas (`additionalProperties: false`) from request/response JSON.
 */
import type {
  CurlImportResult,
  DraftCheck,
  Integration,
  TaskContractInput,
  TaskEffect,
} from "../../packages/contracts/integration-task";
import { closeSchema, slugifyTaskId } from "./integration-mcp";

type JsonObject = Record<string, unknown>;

const MAX_INFER_DEPTH = 6;

function looksLikeJsonSchema(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as JsonObject;
  if (typeof obj.$schema === "string") return true;
  if (obj.type === "object" && obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    return true;
  }
  return false;
}

function inferPrimitiveOrComposite(value: unknown, depth: number): JsonObject {
  if (depth >= MAX_INFER_DEPTH) {
    return { type: "string", maxLength: 400 };
  }
  if (value === null || value === undefined) {
    return { type: "string", maxLength: 200 };
  }
  if (typeof value === "boolean") {
    return { type: "boolean" };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  }
  if (typeof value === "string") {
    const maxLength = Math.max(120, Math.min(2000, value.length * 4));
    return { type: "string", maxLength };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: "array", maxItems: 100, items: { type: "string", maxLength: 200 } };
    }
    const allObjects = value.every((item) => item && typeof item === "object" && !Array.isArray(item));
    if (allObjects) {
      const mergedProps: Record<string, JsonObject> = {};
      const keyCounts = new Map<string, number>();
      for (const item of value as JsonObject[]) {
        for (const [k, v] of Object.entries(item)) {
          keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
          if (!mergedProps[k] || v !== null) {
            mergedProps[k] = inferPrimitiveOrComposite(v, depth + 1);
          }
        }
      }
      const required = [...keyCounts.entries()]
        .filter(([, count]) => count === value.length)
        .map(([k]) => k);
      return {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required,
          properties: mergedProps,
        },
      };
    }
    return {
      type: "array",
      maxItems: 100,
      items: inferPrimitiveOrComposite(value[0], depth + 1),
    };
  }
  const obj = value as JsonObject;
  const properties: Record<string, JsonObject> = {};
  const required: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!k.trim()) continue;
    properties[k] = inferPrimitiveOrComposite(v, depth + 1);
    if (v !== null && v !== undefined) required.push(k);
  }
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

/**
 * Turns either a sample JSON payload OR an existing JSON Schema into a strict closed
 * Draft 2020-12 object schema (`additionalProperties: false` on every object).
 */
export function inferClosedSchemaFromJson(
  parsed: unknown,
  label: "input" | "output",
  notes: string[] = [],
): JsonObject {
  if (looksLikeJsonSchema(parsed)) {
    notes.push(`Detected JSON Schema for ${label} and enforced closed object constraints.`);
    return closeSchema(parsed, notes, label) as JsonObject;
  }
  if (Array.isArray(parsed)) {
    notes.push(`Wrapped top-level JSON array sample into { items: [...] } for ${label} schema.`);
    return {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: inferPrimitiveOrComposite(parsed, 1),
      },
    };
  }
  if (parsed && typeof parsed === "object") {
    return inferPrimitiveOrComposite(parsed, 0);
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: {
      value: inferPrimitiveOrComposite(parsed, 1),
    },
  };
}

/** Shell-aware tokenizer for cURL commands (handles single/double quotes, backslash escapes & line continuations). */
export function tokenizeCurlCommand(raw: string): string[] {
  const normalized = raw
    .trim()
    .replace(/^\$\s+/, "")
    .replace(/\\\r?\n/g, " ");

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasToken = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < normalized.length) {
        const next = normalized[i + 1]!;
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          i++;
          continue;
        }
      }
      if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < normalized.length) {
      current += normalized[i + 1]!;
      hasToken = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function singularParamName(prevSegment: string | undefined): string {
  if (!prevSegment) return "id";
  const clean = prevSegment
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!clean || /^v\d+$/.test(clean) || clean === "api") return "id";
  const singular = clean.endsWith("ies")
    ? clean.slice(0, -3) + "y"
    : clean.endsWith("s") && clean.length > 2
      ? clean.slice(0, -1)
      : clean;
  return `${singular}Id`.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function isLikelyIdSegment(seg: string): boolean {
  if (!seg) return false;
  if (/^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(seg) || /^:[A-Za-z][A-Za-z0-9_]*$/.test(seg)) return true;
  if (/^\d+$/.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  if (/^[A-Za-z]{2,8}[-_]\d+[A-Za-z0-9_-]*$/.test(seg)) return true;
  if (/^(acct|ord|cust|usr|inv|sub|ch|pi|txn|tkt|inc|deal|req)_[A-Za-z0-9]{4,}$/i.test(seg)) return true;
  return false;
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function deriveIntegrationIdentity(url: URL, customId?: string): { id: string; name: string } {
  if (customId?.trim()) {
    const id = slugifyTaskId(customId);
    return { id, name: humanizeSlug(id) };
  }
  const hostParts = url.hostname
    .toLowerCase()
    .split(".")
    .filter((p) => !["www", "api", "rest", "v1", "v2", "com", "org", "net", "io", "dev", "app", "co"].includes(p));
  const rawSlug = hostParts[0] || url.hostname.split(".")[0] || "external_api";
  const id = slugifyTaskId(rawSlug.endsWith("_api") ? rawSlug : `${rawSlug}_api`);
  return { id, name: humanizeSlug(id) };
}

function deriveTaskId(method: string, pathSegments: string[], customTaskId?: string): string {
  if (customTaskId?.trim()) return slugifyTaskId(customTaskId);
  const meaningful = pathSegments.filter(
    (s) => s && !/^v\d+$/i.test(s) && s.toLowerCase() !== "api" && !s.startsWith("{"),
  );
  const prefix =
    method === "GET"
      ? "get"
      : method === "POST"
        ? "create"
        : method === "PUT" || method === "PATCH"
          ? "update"
          : "delete";
  const tail = meaningful.slice(-2).join("_") || "resource";
  return slugifyTaskId(`${prefix}_${tail}`);
}

function inferQueryScalarSchema(rawVal: string): JsonObject {
  if (rawVal === "true" || rawVal === "false") return { type: "boolean" };
  if (/^-?\d+$/.test(rawVal)) return { type: "integer" };
  if (/^-?\d+\.\d+$/.test(rawVal)) return { type: "number" };
  return { type: "string", maxLength: 200 };
}

export function looksLikeCurlCommand(message: string): boolean {
  return /(^|\n)\s*\$?\s*curl\s+/i.test(message);
}

/**
 * Parses a pasted or uploaded cURL command + optional sample JSON output (or JSON Schema)
 * into a ready-to-save Integration connection and strict closed-schema sfield TaskContractInput.
 */
export function parseCurlToIntegrationDraft(
  input: {
    curl: string;
    sampleOutput?: string;
    integrationId?: string;
    taskId?: string;
  },
  existingIntegrations: readonly Integration[],
  validateDraft: (draft: TaskContractInput) => DraftCheck,
): CurlImportResult {
  const tokens = tokenizeCurlCommand(input.curl);
  if (tokens.length === 0) {
    throw new Error("Paste or upload a cURL command starting with `curl`.");
  }
  const startIdx = tokens[0]!.toLowerCase() === "curl" ? 1 : 0;

  let explicitMethod: string | undefined;
  let rawUrl = "";
  let forceGet = false;
  const headers: Array<{ name: string; value: string }> = [];
  const dataParts: string[] = [];
  let basicUser = false;

  for (let i = startIdx; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "-X" || tok === "--request") {
      explicitMethod = tokens[++i]?.toUpperCase();
      continue;
    }
    if (tok.startsWith("-X") && tok.length > 2) {
      explicitMethod = tok.slice(2).toUpperCase();
      continue;
    }
    if (tok === "--url") {
      rawUrl = tokens[++i] ?? rawUrl;
      continue;
    }
    if (tok === "-H" || tok === "--header") {
      const hdr = tokens[++i] ?? "";
      const colon = hdr.indexOf(":");
      if (colon > 0) {
        headers.push({ name: hdr.slice(0, colon).trim(), value: hdr.slice(colon + 1).trim() });
      }
      continue;
    }
    if (
      tok === "-d" ||
      tok === "--data" ||
      tok === "--data-raw" ||
      tok === "--data-binary" ||
      tok === "--data-ascii" ||
      tok === "--data-urlencode" ||
      tok === "--json"
    ) {
      const val = tokens[++i];
      if (val !== undefined) dataParts.push(val);
      continue;
    }
    if (tok === "-G" || tok === "--get") {
      forceGet = true;
      continue;
    }
    if (tok === "-u" || tok === "--user") {
      basicUser = true;
      i++;
      continue;
    }
    if (tok.startsWith("-")) {
      // Skip common flags that take a single value argument
      if (["-o", "--output", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-F", "--form", "--connect-timeout", "-m", "--max-time"].includes(tok)) {
        i++;
      }
      continue;
    }
    if (!rawUrl && /^https?:\/\//i.test(tok)) {
      rawUrl = tok;
    } else if (!rawUrl && /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(tok)) {
      rawUrl = `https://${tok}`;
    }
  }

  if (!rawUrl) {
    throw new Error("Could not find an HTTP/HTTPS URL inside the cURL command.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL detected in cURL command: "${rawUrl}".`);
  }

  const rawBody = dataParts.join("&").trim();
  const inferredMethod = forceGet
    ? "GET"
    : explicitMethod ?? (rawBody ? "POST" : "GET");
  const method = (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(inferredMethod)
    ? inferredMethod
    : "POST") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

  const effect: TaskEffect =
    method === "GET" ? "read" : method === "DELETE" ? "destructive" : "write";

  const notes: string[] = [];
  const baseUrl = parsedUrl.origin;

  // Reuse an existing HTTP integration with the same baseUrl if present
  const matchedExisting =
    (input.integrationId
      ? existingIntegrations.find((e) => e.id === input.integrationId)
      : undefined) ??
    existingIntegrations.find((e) => e.transport === "http" && e.baseUrl.replace(/\/+$/, "") === baseUrl);

  const identity = matchedExisting
    ? { id: matchedExisting.id, name: matchedExisting.name }
    : deriveIntegrationIdentity(parsedUrl, input.integrationId);

  // Detect auth header -> convert to env var secretRef (never store literal secrets!)
  let authHeader: string | undefined;
  let secretRef: string | undefined = matchedExisting?.secretRef;
  const authHdr = headers.find((h) => /^(authorization|x-api-key|api-key|x-auth-token)$/i.test(h.name));
  if (authHdr || basicUser) {
    authHeader = authHdr?.name ?? "Authorization (Basic)";
    const envMatch = authHdr?.value.match(/\$\{?([A-Z][A-Z0-9_]{1,62})\}?/);
    if (envMatch) {
      secretRef = envMatch[1];
      notes.push(`Detected ${authHeader} referencing env var ${secretRef}.`);
    } else {
      const suggested = `${identity.id.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_TOKEN`.slice(0, 60);
      secretRef = secretRef ?? suggested;
      notes.push(`Detected ${authHeader} header; raw credentials were stripped and mapped to env var secretRef "${secretRef}".`);
    }
  }

  // Normalize path segments -> extract dynamic path params ({accountId}, {id}, etc.)
  const rawSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const templateSegments: string[] = [];
  const pathParams: string[] = [];
  const inputProps: Record<string, JsonObject> = {};
  const inputRequired: string[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i]!;
    if (isLikelyIdSegment(seg)) {
      let paramName: string;
      if (/^\{([A-Za-z][A-Za-z0-9_]*)\}$/.test(seg)) {
        paramName = seg.slice(1, -1);
      } else if (/^:([A-Za-z][A-Za-z0-9_]*)$/.test(seg)) {
        paramName = seg.slice(1);
      } else {
        paramName = singularParamName(rawSegments[i - 1]);
      }
      if (paramName in inputProps) paramName = `${paramName}${i}`;
      templateSegments.push(`{${paramName}}`);
      pathParams.push(paramName);
      inputProps[paramName] = { type: "string", minLength: 1, maxLength: 120 };
      inputRequired.push(paramName);
    } else {
      templateSegments.push(seg);
    }
  }
  const pathTemplate = "/" + templateSegments.join("/");

  // Extract query parameters into inputSchema
  const queryParams: string[] = [];
  for (const [qKey, qVal] of parsedUrl.searchParams.entries()) {
    const cleanKey = qKey.replace(/[^A-Za-z0-9_]/g, "");
    if (!cleanKey || cleanKey in inputProps) continue;
    queryParams.push(cleanKey);
    inputProps[cleanKey] = inferQueryScalarSchema(qVal);
  }

  // Parse request JSON body (if present) into inputSchema
  let hasBody = false;
  if (rawBody) {
    hasBody = true;
    try {
      const parsedBody = JSON.parse(rawBody) as unknown;
      const bodySchema = inferClosedSchemaFromJson(parsedBody, "input", notes);
      const bodyProps = (bodySchema.properties ?? {}) as Record<string, JsonObject>;
      const bodyReq = Array.isArray(bodySchema.required) ? (bodySchema.required as string[]) : [];
      for (const [k, schema] of Object.entries(bodyProps)) {
        inputProps[k] = schema;
      }
      for (const reqKey of bodyReq) {
        if (!inputRequired.includes(reqKey)) inputRequired.push(reqKey);
      }
      notes.push(`Inferred ${Object.keys(bodyProps).length} closed input field(s) from request JSON body.`);
    } catch {
      // Fallback: form-urlencoded `a=1&b=2`
      if (rawBody.includes("=")) {
        const sp = new URLSearchParams(rawBody);
        for (const [k, v] of sp.entries()) {
          const clean = k.replace(/[^A-Za-z0-9_]/g, "");
          if (clean && !(clean in inputProps)) {
            inputProps[clean] = inferQueryScalarSchema(v);
            inputRequired.push(clean);
          }
        }
        notes.push("Parsed form-urlencoded request body parameters into input schema.");
      } else {
        notes.push("Request body was not JSON; add request body fields manually in Input Schema.");
      }
    }
  }

  if (effect !== "read" && !("idempotencyKey" in inputProps)) {
    inputProps.idempotencyKey = { type: "string", minLength: 1, maxLength: 80 };
  }

  // Parse optional sample JSON output (or JSON Schema) -> closed outputSchema
  let outputSchema: JsonObject = {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: { result: { type: "string", maxLength: 2000 } },
  };
  let hasSampleOutput = false;
  if (input.sampleOutput?.trim()) {
    try {
      const parsedOut = JSON.parse(input.sampleOutput.trim()) as unknown;
      outputSchema = inferClosedSchemaFromJson(parsedOut, "output", notes);
      hasSampleOutput = true;
      const propCount = Object.keys((outputSchema.properties ?? {}) as Record<string, unknown>).length;
      notes.push(`Inferred strict closed output schema with ${propCount} top-level field(s) from sample response.`);
    } catch {
      throw new Error("Sample output must be valid JSON (either a sample API response or a JSON Schema).");
    }
  } else {
    notes.push("Output schema uses a placeholder — paste or upload a sample JSON response to infer exact response columns for smass & sphoton.");
  }

  const taskId = deriveTaskId(method, templateSegments, input.taskId);
  const resourceIdField = pathParams[0];

  const draft: TaskContractInput = {
    integrationId: identity.id,
    taskId,
    version: "1.0.0",
    description: `${method} ${pathTemplate} on ${identity.name} (imported from cURL).`,
    effect,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: inputRequired,
      properties: inputProps,
    },
    outputSchema,
    resultKind: "data",
    outcomeCodes: [
      { code: "OK", meaning: effect === "read" ? "Succeeded" : "Applied", success: true },
      { code: "REJECTED", meaning: "Upstream rejected request", success: false },
    ],
    outcomeMapping: [
      { statusIn: effect === "read" ? [200] : [200, 201, 202, 204], code: "OK" },
      { statusIn: [400, 404, 409, 422], code: "REJECTED" },
    ],
    approvalPolicy: {
      mode: effect === "read" ? "none" : "always",
      when: [],
      dualControl: false,
      expiresInMinutes: 30,
    },
    idempotency: effect === "read" ? { supported: false } : { supported: true, keyField: "idempotencyKey" },
    ...(resourceIdField ? { resourceIdField } : {}),
    binding: {
      target: pathTemplate,
      method,
    },
  };

  const integration: Partial<Integration> = {
    id: identity.id,
    name: identity.name,
    description: matchedExisting?.description || `HTTP API imported from cURL (${baseUrl}).`,
    transport: "http",
    baseUrl,
    ...(secretRef ? { secretRef } : {}),
    timeoutMs: matchedExisting?.timeoutMs ?? 5000,
    enabled: true,
  };

  const rawCheck = validateDraft(draft);
  const filteredIssues = matchedExisting
    ? rawCheck.issues
    : rawCheck.issues.filter((msg) => !msg.includes(`integration "${identity.id}" does not exist`));
  const check: DraftCheck = {
    ...rawCheck,
    issues: filteredIssues,
    ok: filteredIssues.length === 0,
  };

  return {
    integration,
    existingIntegration: Boolean(matchedExisting),
    draft,
    detected: {
      method,
      url: rawUrl,
      baseUrl,
      pathTemplate,
      pathParams,
      queryParams,
      headersCount: headers.length,
      ...(authHeader ? { authHeader } : {}),
      ...(secretRef ? { secretRef } : {}),
      hasBody,
      hasSampleOutput,
    },
    notes,
    check,
  };
}
