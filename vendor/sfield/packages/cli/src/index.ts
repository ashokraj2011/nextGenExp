/**
 * @sfield/cli: Standalone command-line interface for the sfield Agent SDK.
 *
 * Commands:
 *   sfield init [dir] [--force]
 *   sfield validate [configPath] [--json]
 *   sfield lock status --db <sqlitePath> [--config <configPath> | --digest <digest>] [--json]
 *   sfield lock approve [digest] --db <sqlitePath> [--config <configPath>] --approver <name> [--comment <text>] [--eval-report <id>] [--no-baseline] [--json]
 *   sfield inspect <runId> --db <sqlitePath> [--json]
 *   sfield mcp serve --db <sqlitePath> [--config <configPath>] [--name <name>] [--preset <preset>]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SField, EphemeralPersistence, approveLock, createDevAuthorizer, LOCAL_DEV_PRINCIPAL, nowIso, type JsonObject } from "@sfield/core";
import { sqlitePersistence } from "@sfield/store-sqlite";
import { runEvalSuite, evaluateReleaseGate, type EvalCaseDefinition } from "@sfield/testing";

export interface CliIo {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  cwd?: string;
}

const HELP_TEXT = `sfield — Governed Agent SDK CLI

Usage:
  sfield init [dir] [--force]
      Scaffold a standalone sfield.config.yaml and agent.mjs starter.

  sfield validate [configPath] [--json]
      Compile and validate a sfield config file (default: sfield.config.yaml)
      and print its deterministic lock digest.

  sfield lock status --db <sqlitePath> [--config <configPath> | --digest <digest>] [--json]
      Check lock-manifest approval status in a SQLite persistence store.

  sfield lock approve [digest] --db <sqlitePath> [--config <configPath>] --approver <name> [--comment <text>] [--eval-report <id>] [--no-baseline] [--json]
      Record a governance lock approval for a compiled config digest.

  sfield inspect <runId> --db <sqlitePath> [--json]
      Inspect a persisted run: status, tool calls, model attempts, audit trail,
      and multi-agent delegation tree.

  sfield eval <suiteModule> --db <sqlitePath> [--config <configPath> | --digest <digest>] [--suite <name>] [--gate-min-pass <0..1>] [--json]
      Execute an evaluation suite module (exporting 'cases' or default array),
      persist its EvalReportRecord into SQLite, and evaluate the release gate.

  sfield mcp serve --db <sqlitePath> [--config <configPath>] [--name <name>] [--preset <preset>]
      Expose the SField runtime's governed tools over MCP stdio (JSON-RPC 2.0).

  sfield --help | help
      Show this usage summary.
`;

const STARTER_CONFIG_YAML = `# Standalone sfield agent configuration
version: 1

models:
  primary:
    provider: gemini
    model: gemini-2.5-flash
    credential:
      env: GEMINI_API_KEY
    params:
      temperature: 0.2
      max_output_tokens: 2048

agents:
  assistant:
    model: primary
    instructions: |
      You are a concise, governed assistant powered by @sfield/core.
      Use registered tools whenever factual lookup or state changes are needed.
    policy:
      preset: supervised
    budget:
      max_turns: 8
      max_tool_calls: 16
`;

const STARTER_AGENT_MJS = `// Standalone sfield agent starter
import { SField, defineTool, createDevAuthorizer, LOCAL_DEV_PRINCIPAL } from "@sfield/core";
import { sqlitePersistence } from "@sfield/store-sqlite";

const echoTool = defineTool({
  id: "demo.echo",
  version: "1.0.0",
  description: "Echo a message back with a timestamp.",
  inputs: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  outputs: {
    type: "object",
    properties: { echoed: { type: "string" }, at: { type: "string" } },
    required: ["echoed", "at"],
    additionalProperties: false,
  },
  policy: { effect: "read", classification: "internal" },
  handler: async ({ message }) => ({
    echoed: String(message),
    at: new Date().toISOString(),
  }),
});

const sf = await SField.create({
  config: "./sfield.config.yaml",
  deployment: "durable_single",
  persistence: sqlitePersistence({ path: "./.sfield/state.sqlite" }),
  tools: [echoTool],
  authorizer: createDevAuthorizer(),
  devPrincipal: LOCAL_DEV_PRINCIPAL,
});

console.log("sfield ready. Config digest:", sf.config.digest());
console.log("Registered tools:", sf.registry.list().map((t) => t.ref));

await sf.close();
`;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (token === "-h") {
      flags["help"] = true;
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

function emitJson(out: (s: string) => void, value: unknown): void {
  out(`${JSON.stringify(value, null, 2)}\n`);
}

async function cmdInit(args: ParsedArgs, cwd: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const targetDir = resolve(cwd, args.positionals[1] ?? ".");
  const force = flagBool(args.flags, "force");
  mkdirSync(targetDir, { recursive: true });

  const files: Array<{ name: string; content: string }> = [
    { name: "sfield.config.yaml", content: STARTER_CONFIG_YAML },
    { name: "agent.mjs", content: STARTER_AGENT_MJS },
  ];

  const created: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const full = resolve(targetDir, f.name);
    if (existsSync(full) && !force) {
      skipped.push(full);
      continue;
    }
    writeFileSync(full, f.content, "utf8");
    created.push(full);
  }

  if (flagBool(args.flags, "json")) {
    emitJson(out, { ok: true, dir: targetDir, created, skipped });
    return 0;
  }

  if (created.length === 0 && skipped.length > 0) {
    err(`Files already exist in ${targetDir} (re-run with --force to overwrite).\n`);
    return 1;
  }
  out(`Initialized sfield project in ${targetDir}\n`);
  for (const p of created) out(`  created ${p}\n`);
  for (const p of skipped) out(`  skipped ${p} (already exists)\n`);
  return 0;
}

async function cmdValidate(args: ParsedArgs, cwd: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const configPath = resolve(cwd, args.positionals[1] ?? flagString(args.flags, "config") ?? "sfield.config.yaml");
  const asJson = flagBool(args.flags, "json");
  if (!existsSync(configPath)) {
    const msg = `Config file not found: ${configPath}`;
    if (asJson) emitJson(out, { ok: false, errors: [{ code: "FILE_NOT_FOUND", message: msg }] });
    else err(`${msg}\n`);
    return 1;
  }

  const report = await SField.validate({
    config: configPath,
    checkCredentials: flagBool(args.flags, "strict-env"),
  });
  const summary = {
    ok: report.ok,
    configPath,
    digest: report.digest ?? null,
    agents: report.effective ? Object.keys(report.effective.agents) : [],
    models: report.effective ? Object.keys(report.effective.models) : [],
    tools: report.effective ? Object.keys(report.effective.tools) : [],
    notes: report.notes,
    errors: report.errors,
  };

  if (asJson) {
    emitJson(out, summary);
    return report.ok ? 0 : 1;
  }

  if (!report.ok) {
    err(`Validation FAILED for ${configPath}:\n`);
    for (const e of report.errors) {
      err(`  [${e.code}] ${e.message}${e.suggestion ? ` (${e.suggestion})` : ""}\n`);
    }
    return 1;
  }

  out(`Validation OK: ${configPath}\n`);
  out(`  digest : ${summary.digest}\n`);
  out(`  models : ${summary.models.join(", ") || "(none)"}\n`);
  out(`  agents : ${summary.agents.join(", ") || "(none)"}\n`);
  out(`  tools  : ${summary.tools.join(", ") || "(none)"}\n`);
  return 0;
}

async function resolveDigest(args: ParsedArgs, cwd: string, positionalIndex: number): Promise<string | null> {
  const explicit = flagString(args.flags, "digest") ?? args.positionals[positionalIndex];
  if (explicit) return explicit;
  const cfgPath = flagString(args.flags, "config");
  if (!cfgPath) return null;
  const full = resolve(cwd, cfgPath);
  const report = await SField.validate({ config: full, checkCredentials: false });
  if (!report.ok || !report.digest) {
    throw new Error(`Failed to compile config ${full}: ${report.errors.map((e) => e.message).join("; ")}`);
  }
  return report.digest;
}

async function cmdLock(args: ParsedArgs, cwd: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const sub = args.positionals[1];
  const asJson = flagBool(args.flags, "json");
  const dbFlag = flagString(args.flags, "db");
  if (!dbFlag) {
    err("Missing required --db <sqlitePath> flag.\n");
    return 1;
  }
  const dbPath = resolve(cwd, dbFlag);
  const store = sqlitePersistence({ path: dbPath });
  await store.init({ namespace: "sfield-cli", ownerId: `cli-${process.pid}` });

  try {
    if (sub === "status") {
      const digest = await resolveDigest(args, cwd, 2);
      const record = digest ? await store.lockApprovals.get(digest) : await store.lockApprovals.latest();
      const payload = {
        ok: true,
        digest: digest ?? record?.digest ?? null,
        approved: Boolean(record),
        record,
      };
      if (asJson) emitJson(out, payload);
      else if (record) {
        out(`Lock APPROVED\n`);
        out(`  digest   : ${record.digest}\n`);
        out(`  approver : ${record.approver}\n`);
        out(`  decided  : ${record.decidedAt}\n`);
        if (record.comment) out(`  comment  : ${record.comment}\n`);
        if (record.evalReportId) out(`  eval     : ${record.evalReportId}\n`);
      } else {
        out(`Lock UNAPPROVED${digest ? ` for digest ${digest}` : ""}\n`);
      }
      return 0;
    }

    if (sub === "approve") {
      const digest = await resolveDigest(args, cwd, 2);
      if (!digest) {
        err("Provide a <digest> argument, --digest <digest>, or --config <configPath>.\n");
        return 1;
      }
      const approver = flagString(args.flags, "approver") ?? process.env["USER"] ?? "cli-operator";
      const comment = flagString(args.flags, "comment");
      const evalReportId = flagString(args.flags, "eval-report");
      const noBaseline = flagBool(args.flags, "no-baseline");

      const result = await approveLock(
        {
          digest,
          approver,
          ...(comment ? { comment } : {}),
          ...(evalReportId ? { evalReportId } : {}),
          ...(noBaseline ? { noBaseline } : {}),
        },
        undefined,
        { lockApprovals: store.lockApprovals, evalReports: store.evalReports },
      );

      if (asJson) emitJson(out, { ok: true, ...result });
      else {
        out(`Lock ${result.changed ? "approved" : "already approved"}: ${result.record.digest}\n`);
        out(`  approver : ${result.record.approver}\n`);
        out(`  decided  : ${result.record.decidedAt}\n`);
      }
      return 0;
    }

    err(`Unknown lock subcommand "${sub ?? ""}". Expected "status" or "approve".\n`);
    return 1;
  } finally {
    await store.close();
  }
}

async function cmdInspect(args: ParsedArgs, cwd: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const runId = args.positionals[1];
  const asJson = flagBool(args.flags, "json");
  const dbFlag = flagString(args.flags, "db");
  if (!runId) {
    err("Usage: sfield inspect <runId> --db <sqlitePath> [--json]\n");
    return 1;
  }
  if (!dbFlag) {
    err("Missing required --db <sqlitePath> flag.\n");
    return 1;
  }

  const store = sqlitePersistence({ path: resolve(cwd, dbFlag) });
  await store.init({ namespace: "sfield-cli", ownerId: `cli-${process.pid}` });

  try {
    const run = await store.getRun(runId);
    if (!run) {
      const msg = `Run ${runId} not found in ${dbFlag}`;
      if (asJson) emitJson(out, { ok: false, error: msg });
      else err(`${msg}\n`);
      return 1;
    }

    const [calls, modelAttempts, audit, eventsResult] = await Promise.all([
      store.listCalls(runId),
      store.listModelAttempts(runId),
      store.readAudit({ runId, limit: 200 }),
      store.readEvents(runId, 0, 200),
    ]);

    const delegations = audit
      .filter((a) => a.type === "agent_delegation")
      .map((a) => a.data);

    const report = {
      ok: true,
      inspectedAt: nowIso(),
      run: {
        runId: run.runId,
        agentId: run.agentId,
        tenantId: run.tenantId,
        subjectId: run.subjectId,
        state: run.state,
        configDigest: run.configDigest,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        usage: run.usage,
        output: run.output ?? null,
        error: run.error ?? null,
      },
      calls: calls.map((c) => ({
        callId: c.callId,
        toolRef: c.toolRef,
        state: c.state,
        turn: c.turn,
        attempts: c.attempts.length,
        status: c.result?.status ?? null,
      })),
      modelAttempts: modelAttempts.map((m) => ({
        attemptId: m.attemptId,
        model: m.model,
        status: m.status,
        durationMs: m.durationMs,
        costMicroUsd: m.costMicroUsd ?? 0,
      })),
      auditCount: audit.length,
      eventCount: eventsResult.events.length,
      delegations,
    };

    if (asJson) {
      emitJson(out, report);
      return 0;
    }

    out(`Run ${run.runId} (${run.state})\n`);
    out(`  agent   : ${run.agentId}\n`);
    out(`  tenant  : ${run.tenantId} / ${run.subjectId}\n`);
    out(`  digest  : ${run.configDigest}\n`);
    out(`  calls   : ${calls.length} (${calls.map((c) => `${c.toolRef}:${c.state}`).join(", ") || "none"})\n`);
    out(`  models  : ${modelAttempts.length} attempt(s)\n`);
    out(`  audit   : ${audit.length} record(s), ${eventsResult.events.length} event(s)\n`);
    if (delegations.length > 0) {
      out(`  delegations: ${delegations.length}\n`);
    }
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdEval(args: ParsedArgs, cwd: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const suiteFile = args.positionals[1];
  const asJson = flagBool(args.flags, "json");
  if (!suiteFile) {
    err("Usage: sfield eval <suiteModule> --db <sqlitePath> [--config <configPath> | --digest <digest>] [--suite <name>] [--gate-min-pass <0..1>] [--json]\n");
    return 1;
  }
  const fullSuitePath = resolve(cwd, suiteFile);
  if (!existsSync(fullSuitePath)) {
    err(`Eval suite module not found: ${fullSuitePath}\n`);
    return 1;
  }

  const mod = (await import(pathToFileURL(fullSuitePath).href)) as {
    cases?: EvalCaseDefinition[];
    suite?: string;
    default?: EvalCaseDefinition[] | { suite?: string; cases?: EvalCaseDefinition[] };
  };
  const cases = Array.isArray(mod.cases)
    ? mod.cases
    : Array.isArray(mod.default)
      ? mod.default
      : Array.isArray(mod.default?.cases)
        ? mod.default.cases
        : null;
  if (!cases || cases.length === 0) {
    err(`Eval module ${fullSuitePath} must export a non-empty 'cases' array.\n`);
    return 1;
  }

  const suiteName = flagString(args.flags, "suite")
    ?? mod.suite
    ?? (!Array.isArray(mod.default) ? mod.default?.suite : undefined)
    ?? "default";
  const digest = (await resolveDigest(args, cwd, 99)) ?? "sha256:unpinned";
  const minPassRaw = flagString(args.flags, "gate-min-pass");
  const minPassRate = minPassRaw !== undefined ? Number(minPassRaw) : 1.0;

  const dbFlag = flagString(args.flags, "db");
  const store = dbFlag ? sqlitePersistence({ path: resolve(cwd, dbFlag) }) : null;
  if (store) {
    await store.init({ namespace: "sfield-cli", ownerId: `cli-${process.pid}` });
  }

  try {
    const result = await runEvalSuite(cases, {
      suite: suiteName,
      candidateDigest: digest,
      ...(store ? { evalReports: store.evalReports } : {}),
    });
    const gate = evaluateReleaseGate(result.report, {
      minPassRate: Number.isFinite(minPassRate) ? minPassRate : 1.0,
    });

    const payload = {
      ok: gate.decision === "ready_to_publish",
      suite: suiteName,
      reportId: result.report.id,
      candidateDigest: digest,
      totalCases: result.totalCases,
      passedCases: result.passedCases,
      failedCases: result.failedCases,
      passRate: result.report.passRate,
      avgLatencyMs: result.avgLatencyMs,
      gate,
      cases: result.cases,
    };

    if (asJson) {
      emitJson(out, payload);
    } else {
      out(`Eval suite "${suiteName}" — ${result.passedCases}/${result.totalCases} passed (${Math.round(result.report.passRate * 100)}%)\n`);
      out(`  reportId : ${result.report.id}\n`);
      out(`  digest   : ${digest}\n`);
      out(`  gate     : ${gate.decision}${gate.reasons.length ? ` (${gate.reasons.join("; ")})` : ""}\n`);
    }
    return gate.decision === "ready_to_publish" ? 0 : 1;
  } finally {
    await store?.close();
  }
}

async function cmdMcpServe(args: ParsedArgs, cwd: string, err: (s: string) => void): Promise<number> {
  const sub = args.positionals[1];
  if (sub !== "serve") {
    err(`Unknown mcp subcommand "${sub ?? ""}". Expected "serve".\n`);
    return 1;
  }

  const dbFlag = flagString(args.flags, "db");
  const configFlag = flagString(args.flags, "config");
  const name = flagString(args.flags, "name") ?? "sfield-mcp";
  const preset = (flagString(args.flags, "preset") ?? "supervised") as "read_only" | "supervised" | "bounded_auto";

  const config: string | JsonObject = configFlag
    ? resolve(cwd, configFlag)
    : {
        version: 1,
        models: {},
        agents: {},
      };

  const persistence = dbFlag ? sqlitePersistence({ path: resolve(cwd, dbFlag) }) : new EphemeralPersistence();
  const sf = await SField.create({
    config,
    deployment: dbFlag ? "durable_single" : "ephemeral",
    persistence,
    authorizer: createDevAuthorizer(),
    devPrincipal: LOCAL_DEV_PRINCIPAL,
    quiet: true,
  });

  const server = sf.createMcpServer({
    serverInfo: { name, version: "0.1.0" },
    preset,
  });

  try {
    await server.serveStdio();
    return 0;
  } finally {
    await sf.close();
  }
}

/**
 * Programmatic CLI entrypoint. Returns process exit code (0 = success, non-zero = failure).
 */
export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const out = io.stdout ?? ((s: string) => process.stdout.write(s));
  const err = io.stderr ?? ((s: string) => process.stderr.write(s));
  const cwd = io.cwd ?? process.cwd();

  const args = parseArgs(argv);
  const cmd = args.positionals[0];

  if (!cmd || cmd === "help" || flagBool(args.flags, "help")) {
    out(HELP_TEXT);
    return 0;
  }

  try {
    switch (cmd) {
      case "init":
        return await cmdInit(args, cwd, out, err);
      case "validate":
        return await cmdValidate(args, cwd, out, err);
      case "lock":
        return await cmdLock(args, cwd, out, err);
      case "inspect":
        return await cmdInspect(args, cwd, out, err);
      case "eval":
        return await cmdEval(args, cwd, out, err);
      case "mcp":
        return await cmdMcpServe(args, cwd, err);
      default:
        err(`Unknown command "${cmd}". Run "sfield --help" for usage.\n`);
        return 1;
    }
  } catch (e) {
    err(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
