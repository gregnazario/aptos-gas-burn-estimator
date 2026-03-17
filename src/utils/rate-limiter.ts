import { CONFIG } from "../config.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimiter {
  private activeConcurrent = 0;
  private lastRequestTime = 0;
  private waitQueue: Array<() => void> = [];

  private tryAcquire(): boolean {
    if (this.activeConcurrent < CONFIG.MAX_CONCURRENT_REQUESTS) {
      this.activeConcurrent++;
      return true;
    }
    return false;
  }

  private release(): void {
    this.activeConcurrent--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  private waitForSlot(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.activeConcurrent++;
        resolve();
      });
    });
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForSlot();
    try {
      // Enforce minimum delay between requests
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < CONFIG.MIN_REQUEST_DELAY_MS) {
        await sleep(CONFIG.MIN_REQUEST_DELAY_MS - elapsed);
      }
      this.lastRequestTime = Date.now();

      return await this.retryWithBackoff(fn);
    } finally {
      this.release();
    }
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        if (attempt === CONFIG.MAX_RETRIES) throw err;

        const status = (err as { status?: number }).status;
        if (status && status !== 429 && status < 500) throw err;

        const retryAfter = (err as { retryAfter?: number }).retryAfter;
        const backoff = retryAfter
          ? retryAfter * 1000
          : Math.min(CONFIG.BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 1000, CONFIG.MAX_BACKOFF_MS);

        console.log(`Rate limiter: attempt ${attempt + 1} failed, backing off ${Math.round(backoff)}ms`);
        await sleep(backoff);
      }
    }
    throw new Error("Unreachable");
  }
}

export const rateLimiter = new RateLimiter();
