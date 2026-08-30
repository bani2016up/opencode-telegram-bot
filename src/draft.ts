import type { Api, RawApi } from "grammy";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export class ThinkingDraft {
  readonly draftId = Math.floor(Math.random() * 2_000_000_000) + 1;
  private timer: NodeJS.Timeout | undefined;
  private pending = "Request received. Starting OpenCode…";
  private sent = "";
  private stopped = false;

  constructor(
    private readonly api: Api<RawApi>,
    private readonly chatId: number,
    private readonly intervalMs: number,
  ) {}

  async start(): Promise<void> {
    await this.flush();
  }

  update(text: string): void {
    if (this.stopped) return;
    this.pending = text.slice(-16_000);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.intervalMs);
    }
  }

  finish(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.pending === this.sent) return;
    const content = this.pending;
    try {
      await this.api.sendRichMessageDraft(
        this.chatId,
        this.draftId,
        { html: `<tg-thinking>${escapeHtml(content)}</tg-thinking>` },
        { can_stop: true, keep_on_stop: false },
      );
      this.sent = content;
    } catch {
      // Draft updates are best-effort. The final response is still persisted.
    }
  }
}
