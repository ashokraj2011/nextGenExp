/**
 * First-class Token-Bucket Rate Limiter & 3-State Circuit Breaker middleware for @sfield/core tools.
 *
 * Prevents cascading failures and upstream quota exhaustion across external connectors,
 * MCP proxy tools, and integration adapters.
 */
import { SFieldError } from "../errors.js";

export interface RateLimitConfig {
  /** Maximum burst tokens. Defaults to 20. */
  capacity: number;
  /** Sustained refill rate in tokens/second. Defaults to 5. */
  refillPerSecond: number;
}

export interface CircuitBreakerConfig {
  /** Consecutive failures required to trip circuit to `"open"`. Defaults to 5. */
  failureThreshold: number;
  /** Cooldown period in ms before allowing a `"half_open"` probe call. Defaults to 30_000. */
  cooldownMs: number;
}

export type CircuitState = "closed" | "open" | "half_open";

export interface ResilienceStatus {
  key: string;
  circuit: CircuitState;
  consecutiveFailures: number;
  tokensAvailable: number;
  nextRetryAt?: string;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

interface BreakerEntry {
  state: CircuitState;
  consecutiveFailures: number;
  openedAtMs?: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly now: () => number;

  constructor(
    private readonly defaults: RateLimitConfig = { capacity: 20, refillPerSecond: 5 },
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  consume(key: string, cost = 1, override?: Partial<RateLimitConfig>): { allowed: boolean; retryAfterMs: number; remaining: number } {
    const cap = override?.capacity ?? this.defaults.capacity;
    const rate = override?.refillPerSecond ?? this.defaults.refillPerSecond;
    const t = this.now();
    const cur = this.buckets.get(key) ?? { tokens: cap, lastRefillMs: t };
    const elapsedSec = Math.max(0, (t - cur.lastRefillMs) / 1000);
    const refilled = Math.min(cap, cur.tokens + elapsedSec * rate);
    if (refilled >= cost) {
      const remaining = refilled - cost;
      this.buckets.set(key, { tokens: remaining, lastRefillMs: t });
      return { allowed: true, retryAfterMs: 0, remaining };
    }
    this.buckets.set(key, { tokens: refilled, lastRefillMs: t });
    const deficit = cost - refilled;
    const retryAfterMs = rate > 0 ? Math.ceil((deficit / rate) * 1000) : 1000;
    return { allowed: false, retryAfterMs, remaining: refilled };
  }

  remaining(key: string, override?: Partial<RateLimitConfig>): number {
    const cap = override?.capacity ?? this.defaults.capacity;
    const rate = override?.refillPerSecond ?? this.defaults.refillPerSecond;
    const cur = this.buckets.get(key);
    if (!cur) return cap;
    const elapsedSec = Math.max(0, (this.now() - cur.lastRefillMs) / 1000);
    return Math.min(cap, cur.tokens + elapsedSec * rate);
  }

  reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}

export class CircuitBreaker {
  private readonly entries = new Map<string, BreakerEntry>();
  private readonly now: () => number;

  constructor(
    private readonly defaults: CircuitBreakerConfig = { failureThreshold: 5, cooldownMs: 30_000 },
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  inspect(key: string, override?: Partial<CircuitBreakerConfig>): { state: CircuitState; consecutiveFailures: number; retryAfterMs: number } {
    const cooldownMs = override?.cooldownMs ?? this.defaults.cooldownMs;
    const entry = this.entries.get(key);
    if (!entry) return { state: "closed", consecutiveFailures: 0, retryAfterMs: 0 };
    if (entry.state === "open" && entry.openedAtMs !== undefined) {
      const elapsed = this.now() - entry.openedAtMs;
      if (elapsed >= cooldownMs) {
        entry.state = "half_open";
        return { state: "half_open", consecutiveFailures: entry.consecutiveFailures, retryAfterMs: 0 };
      }
      return { state: "open", consecutiveFailures: entry.consecutiveFailures, retryAfterMs: Math.max(1, cooldownMs - elapsed) };
    }
    return { state: entry.state, consecutiveFailures: entry.consecutiveFailures, retryAfterMs: 0 };
  }

  recordSuccess(key: string): void {
    this.entries.set(key, { state: "closed", consecutiveFailures: 0 });
  }

  recordFailure(key: string, override?: Partial<CircuitBreakerConfig>): CircuitState {
    const threshold = override?.failureThreshold ?? this.defaults.failureThreshold;
    const cur = this.entries.get(key) ?? { state: "closed" as CircuitState, consecutiveFailures: 0 };
    const nextFailures = cur.consecutiveFailures + 1;
    if (cur.state === "half_open" || nextFailures >= threshold) {
      this.entries.set(key, { state: "open", consecutiveFailures: nextFailures, openedAtMs: this.now() });
      return "open";
    }
    this.entries.set(key, { state: "closed", consecutiveFailures: nextFailures });
    return "closed";
  }

  reset(key?: string): void {
    if (key) this.entries.delete(key);
    else this.entries.clear();
  }
}

export class ToolResilienceGuard {
  readonly rateLimiter: TokenBucketRateLimiter;
  readonly breaker: CircuitBreaker;
  private readonly now: () => number;

  constructor(
    opts: {
      rateLimit?: RateLimitConfig;
      circuitBreaker?: CircuitBreakerConfig;
      now?: () => number;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.rateLimiter = new TokenBucketRateLimiter(opts.rateLimit, this.now);
    this.breaker = new CircuitBreaker(opts.circuitBreaker, this.now);
  }

  status(key: string): ResilienceStatus {
    const cb = this.breaker.inspect(key);
    return {
      key,
      circuit: cb.state,
      consecutiveFailures: cb.consecutiveFailures,
      tokensAvailable: Math.round(this.rateLimiter.remaining(key) * 100) / 100,
      ...(cb.retryAfterMs > 0 ? { nextRetryAt: new Date(this.now() + cb.retryAfterMs).toISOString() } : {}),
    };
  }

  async execute<T>(
    key: string,
    fn: () => Promise<T>,
    override?: { rateLimit?: Partial<RateLimitConfig>; circuitBreaker?: Partial<CircuitBreakerConfig> },
  ): Promise<T> {
    const cb = this.breaker.inspect(key, override?.circuitBreaker);
    if (cb.state === "open") {
      throw new SFieldError("CIRCUIT_OPEN", `Circuit breaker for "${key}" is open; retry after ${cb.retryAfterMs}ms`, {
        retryable: true,
        details: { key, retryAfterMs: cb.retryAfterMs },
      });
    }
    const rl = this.rateLimiter.consume(key, 1, override?.rateLimit);
    if (!rl.allowed) {
      throw new SFieldError("RATE_LIMITED", `Rate limit exceeded for "${key}"; retry after ${rl.retryAfterMs}ms`, {
        retryable: true,
        details: { key, retryAfterMs: rl.retryAfterMs },
      });
    }
    try {
      const result = await fn();
      this.breaker.recordSuccess(key);
      return result;
    } catch (err) {
      this.breaker.recordFailure(key, override?.circuitBreaker);
      throw err;
    }
  }

  reset(key?: string): void {
    this.rateLimiter.reset(key);
    this.breaker.reset(key);
  }
}

export function createToolResilienceGuard(opts?: {
  rateLimit?: RateLimitConfig;
  circuitBreaker?: CircuitBreakerConfig;
  now?: () => number;
}): ToolResilienceGuard {
  return new ToolResilienceGuard(opts);
}
