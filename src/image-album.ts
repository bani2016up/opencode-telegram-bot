/** Telegram sends separate updates without an album-complete event. */
export class ImageAlbum<T> {
  private readonly items = new Map<number, T>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private finish: (() => void) | undefined;
  private failure: Error | undefined;
  closed = false;

  constructor(
    private readonly quietMs = 1500,
    private readonly deadlineMs = 15_000,
  ) {}

  add(messageId: number, item: T): "added" | "duplicate" | "closed" {
    if (this.items.has(messageId)) return "duplicate";
    if (this.closed) return "closed";
    if (this.items.size >= 10) {
      this.failure = new Error("An image album can contain at most 10 images.");
      this.close();
      return "closed";
    }
    this.items.set(messageId, item);
    if (this.finish) this.resetIdleTimer();
    return "added";
  }

  private resetIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.quietMs);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.deadlineTimer);
    this.finish?.();
  }

  async collect(signal: AbortSignal): Promise<T[]> {
    signal.throwIfAborted();
    if (!this.closed) {
      await new Promise<void>((resolve) => {
        const abort = () => this.close();
        this.finish = () => {
          signal.removeEventListener("abort", abort);
          this.finish = undefined;
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        this.resetIdleTimer();
        this.deadlineTimer = setTimeout(() => {
          this.failure = new Error(
            "Album delivery timed out. No images were submitted; please resend the complete album.",
          );
          this.close();
        }, this.deadlineMs);
        if (signal.aborted) this.close();
      });
    }
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    return [...this.items].sort(([left], [right]) => left - right).map(([, item]) => item);
  }
}
