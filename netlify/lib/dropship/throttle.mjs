/**
 * CJ free-tier: ~1 QPS per user, daily points quota (~50k base).
 * Product list ≈ 50 points, product query ≈ 10. Never burn the whole day in one run.
 */

const DEFAULT_MIN_INTERVAL_MS = 1100;
const DEFAULT_MAX_POINTS_PER_RUN = 8000; // leave most of the day for later jobs
const DEFAULT_SOFT_FLOOR = 2000; // stop catalog pulls when below this

export class ThrottledQueue {
  /**
   * @param {{ minIntervalMs?: number, maxPointsPerRun?: number, softFloor?: number, pointsRemaining?: number|null }} [opts]
   */
  constructor(opts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxPointsPerRun = opts.maxPointsPerRun ?? DEFAULT_MAX_POINTS_PER_RUN;
    this.softFloor = opts.softFloor ?? DEFAULT_SOFT_FLOOR;
    this.pointsRemaining = opts.pointsRemaining ?? null;
    this.pointsSpent = 0;
    this._lastAt = 0;
    this._chain = Promise.resolve();
  }

  /** Serialize calls and enforce spacing. */
  enqueue(fn) {
    const run = this._chain.then(async () => {
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this._lastAt));
      if (wait) await sleep(wait);
      this._lastAt = Date.now();
      return fn();
    });
    this._chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  canSpend(points) {
    if (this.pointsSpent + points > this.maxPointsPerRun) return false;
    if (this.pointsRemaining != null && this.pointsRemaining - points < this.softFloor) return false;
    return true;
  }

  recordSpend(points) {
    const n = Math.max(0, Number(points) || 0);
    this.pointsSpent += n;
    if (this.pointsRemaining != null) this.pointsRemaining = Math.max(0, this.pointsRemaining - n);
  }

  /**
   * Retry with exponential backoff on HTTP 429 / points exhaustion.
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{ attempts?: number, isRetryable?: (err: any) => boolean }} [opts]
   */
  async withBackoff(fn, opts = {}) {
    const attempts = opts.attempts ?? 5;
    const isRetryable =
      opts.isRetryable ||
      ((err) => {
        const status = err?.status || err?.httpStatus;
        const code = err?.code || err?.body?.code;
        return status === 429 || code === 1600200 || code === 16900500;
      });
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.enqueue(fn);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || i === attempts - 1) throw err;
        const base = Math.min(30_000, 1000 * 2 ** i);
        const jitter = Math.floor(Math.random() * 400);
        await sleep(base + jitter);
      }
    }
    throw lastErr;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export const CJ_POINTS = {
  LIST: 50,
  QUERY: 10,
  ORDER: 0,
  TRACK: 0,
  AUTH: 0,
};
