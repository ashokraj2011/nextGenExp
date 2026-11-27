/**
 * Integration resilience primitives backed directly by @sfield/core's
 * `TokenBucketRateLimiter` and `CircuitBreaker`, plus HMAC-SHA256 async callback signing.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { CircuitBreaker, TokenBucketRateLimiter } from "@sfield/core";
import type { Integration, IntegrationResilienceSnapshot } from "../../packages/contracts/integration-task";

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

export class IntegrationResilience {
  private readonly limiter: TokenBucketRateLimiter;
  private readonly breaker: CircuitBreaker;
  private readonly openedAt = new Map<string, number>();
  private readonly rejectedRateLimit = new Map<string, number>();
  private readonly rejectedCircuit = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {
    this.limiter = new TokenBucketRateLimiter({ capacity: 60, refillPerSecond: 1 }, now);
    this.breaker = new CircuitBreaker({ failureThreshold: DEFAULT_FAILURE_THRESHOLD, cooldownMs: DEFAULT_RESET_TIMEOUT_MS }, now);
  }

  private breakerConfig(integration: Integration) {
    return {
      failureThreshold: integration.circuitBreaker?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      cooldownMs: integration.circuitBreaker?.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS,
    };
  }

  /** Checks circuit breaker first, then consumes a rate-limit token if configured. */
  checkBeforeCall(integration: Integration):
    | { ok: true }
    | { ok: false; kind: "circuit_open" | "rate_limited"; retryAfterMs: number; message: string } {
    const cfg = this.breakerConfig(integration);
    const status = this.breaker.inspect(integration.id, cfg);

    if (status.state === "open") {
      this.rejectedCircuit.set(integration.id, (this.rejectedCircuit.get(integration.id) ?? 0) + 1);
      const retryAfterMs = Math.max(100, status.retryAfterMs);
      return {
        ok: false,
        kind: "circuit_open",
        retryAfterMs,
        message: `Circuit breaker is OPEN for "${integration.name}" after ${status.consecutiveFailures} consecutive failure(s). Retry in ${Math.ceil(retryAfterMs / 1000)}s or reset the circuit.`,
      };
    }

    if (integration.rateLimit) {
      const rpm = integration.rateLimit.requestsPerMinute;
      const burst = integration.rateLimit.burst ?? rpm;
      const res = this.limiter.consume(integration.id, 1, { capacity: burst, refillPerSecond: rpm / 60 });
      if (!res.allowed) {
        this.rejectedRateLimit.set(integration.id, (this.rejectedRateLimit.get(integration.id) ?? 0) + 1);
        return {
          ok: false,
          kind: "rate_limited",
          retryAfterMs: res.retryAfterMs,
          message: `Local rate limit exceeded for "${integration.name}" (${rpm} req/min, burst ${burst}). Retry in ${Math.max(1, Math.ceil(res.retryAfterMs / 1000))}s.`,
        };
      }
    }

    return { ok: true };
  }

  /** Records a healthy response (closes half-open circuit and clears failure streak). */
  recordSuccess(integration: Integration) {
    this.breaker.recordSuccess(integration.id);
    this.openedAt.delete(integration.id);
  }

  /** Records a transport/timeout/5xx failure and trips the breaker once threshold is reached. */
  recordFailure(integration: Integration) {
    const cfg = this.breakerConfig(integration);
    const nextState = this.breaker.recordFailure(integration.id, cfg);
    if (nextState === "open") {
      this.openedAt.set(integration.id, this.now());
    }
  }

  /** Operator reset: closes circuit and restores full token bucket. */
  reset(integrationId: string) {
    this.breaker.reset(integrationId);
    this.limiter.reset(integrationId);
    this.openedAt.delete(integrationId);
    this.rejectedRateLimit.delete(integrationId);
    this.rejectedCircuit.delete(integrationId);
  }

  snapshot(integration: Integration): IntegrationResilienceSnapshot {
    const cfg = this.breakerConfig(integration);
    const status = this.breaker.inspect(integration.id, cfg);
    const openedAtMs = status.state === "closed" ? undefined : this.openedAt.get(integration.id);
    let rateLimitSnap: IntegrationResilienceSnapshot["rateLimit"];
    if (integration.rateLimit) {
      const rpm = integration.rateLimit.requestsPerMinute;
      const burst = integration.rateLimit.burst ?? rpm;
      const tokens = this.limiter.remaining(integration.id, { capacity: burst, refillPerSecond: rpm / 60 });
      rateLimitSnap = { requestsPerMinute: rpm, burst, tokensRemaining: Math.floor(tokens * 10) / 10 };
    }
    return {
      integrationId: integration.id,
      circuitState: status.state,
      consecutiveFailures: status.consecutiveFailures,
      failureThreshold: cfg.failureThreshold,
      resetTimeoutMs: cfg.cooldownMs,
      ...(openedAtMs !== undefined ? {
        openedAt: new Date(openedAtMs).toISOString(),
        nextAttemptAt: new Date(openedAtMs + cfg.cooldownMs).toISOString(),
      } : {}),
      ...(rateLimitSnap ? { rateLimit: rateLimitSnap } : {}),
      rejectedRateLimitCount: this.rejectedRateLimit.get(integration.id) ?? 0,
      rejectedCircuitCount: this.rejectedCircuit.get(integration.id) ?? 0,
    };
  }
}

/** Signs an async completion webhook payload with HMAC-SHA256 (`sha256=<hex>`). */
export function signAsyncCallback(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Constant-time verification of `X-CEP-Signature: sha256=<hex>`. */
export function verifyAsyncCallback(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = signAsyncCallback(rawBody, secret);
  const a = Buffer.from(signatureHeader.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
