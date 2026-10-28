export const receiveRetrySeconds = attempts => Math.min(900, 30 * 2 ** Math.min(5, Math.max(0, attempts - 1)));

/** Persist progress after each idempotent step. A killed worker's lease expires. */
export async function executeReceiveJob(job, { step, save, now = () => Date.now() }) {
  const done = new Set(job.completed_steps || []);
  try {
    for (const name of ['photos', 'autofill', 'categories', 'channels', 'visibility']) {
      if (done.has(name)) continue;
      await save({ step: name });
      await step(name);
      done.add(name);
      await save({ completed_steps: [...done] });
    }
    await save({ status: 'done', last_error: null, lease: null, lease_until: null });
    return { sku: job.sku, done: true };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    await save({ status: 'retry', last_error: message, lease: null, lease_until: null,
      next_attempt_at: new Date(now() + receiveRetrySeconds(job.attempts) * 1000).toISOString() });
    return { sku: job.sku, retry: true, error: message };
  }
}

