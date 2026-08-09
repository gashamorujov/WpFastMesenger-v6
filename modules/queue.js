/**
 * Queue — sequential FIFO worker.
 *
 * Guarantees:
 *  - items are processed one at a time (never in parallel)
 *  - a random delay is applied between items (WhatsApp rate limiting)
 *  - per-item errors are isolated: one failure never stops the rest
 *  - cancel() stops the worker as soon as possible and clears pending items
 */
const { makeLogger } = require('./logger');

const LOG = makeLogger('QUEUE');

class Queue {
  /**
   * @param {object} opts
   * @param {(item: any) => Promise<void>} opts.onItem — processes one item
   * @param {number} [opts.delayMin] — min delay between items (ms)
   * @param {number} [opts.delayMax] — max delay between items (ms)
   * @param {(stats: {busy: boolean, queued: number}) => void} [opts.onStateChange]
   */
  constructor(opts = {}) {
    this.onItem = opts.onItem;
    this.delayMin = opts.delayMin ?? 2500;
    this.delayMax = opts.delayMax ?? 6000;
    this.onStateChange = opts.onStateChange;

    this.items = [];
    this.running = false;
    this.cancelled = false;

    this.success = 0;
    this.failed = 0;
    this.lastError = null;

    this._sleepTimer = null;
    this._wake = null;
  }

  get size() {
    return this.items.length;
  }

  get busy() {
    return this.running || this.items.length > 0;
  }

  /**
   * Add an item to the queue and ensure the worker is running.
   * @returns {Promise<void>} resolves when the queue drains
   */
  push(item) {
    this.items.push(item);
    this._emit();
    return this.run();
  }

  /**
   * Cancel the worker: clear pending items and stop as soon as possible.
   * Already-started items finish; nothing new starts after cancel.
   */
  cancel() {
    this.cancelled = true;
    this.items.length = 0;
    if (this._wake) this._wake();
    this._emit();
  }

  /** Clear all pending items without stopping the current run. */
  clear() {
    this.items.length = 0;
    this._emit();
  }

  /**
   * Remove queued items matching a predicate (used to cancel specific jobs
   * without disturbing other queued work). The running item is unaffected.
   * @returns {number} how many items were removed
   */
  removeWhere(pred) {
    const before = this.items.length;
    this.items = this.items.filter((item) => !pred(item));
    const removed = before - this.items.length;
    if (removed > 0) this._emit();
    return removed;
  }

  _emit() {
    if (this.onStateChange) {
      try {
        this.onStateChange({ busy: this.busy, queued: this.items.length });
      } catch (e) {
        LOG.error('onStateChange error:', e.message);
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._wake = () => {
        if (this._sleepTimer) clearTimeout(this._sleepTimer);
        this._sleepTimer = null;
        this._wake = null;
        resolve();
      };
      this._sleepTimer = setTimeout(() => {
        this._sleepTimer = null;
        this._wake = null;
        resolve();
      }, ms);
    });
  }

  async run() {
    if (this.running) return this.drain;
    this.running = true;
    this.cancelled = false;

    this.drain = (async () => {
      try {
        while (this.items.length > 0 && !this.cancelled) {
          const item = this.items.shift();
          this._emit();
          try {
            await this.onItem(item);
            this.success++;
          } catch (e) {
            this.failed++;
            this.lastError = e;
            LOG.error('Item failed:', e.message);
          }

          // Random small delay between sends so WhatsApp stays stable.
          if (this.items.length > 0 && !this.cancelled) {
            const delay = this.delayMin + Math.random() * (this.delayMax - this.delayMin);
            await this._sleep(delay);
          }
        }
      } finally {
        this.running = false;
        this.drain = null;
        if (this._wake) { this._wake = null; }
        this._emit();
      }
    })();

    return this.drain;
  }
}

module.exports = { Queue };
