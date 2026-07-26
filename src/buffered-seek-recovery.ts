import { bufferedRangeAt } from "./media-buffer";

const RECOVERY_DELAY_MS = 500;
const RECOVERY_NUDGE_MS = 100;
const RANGE_END_MARGIN_MS = 100;

type SeekMedia = Pick<
  HTMLVideoElement,
  "addEventListener" | "buffered" | "currentTime" | "removeEventListener" | "seeking"
>;

type Scheduler = (callback: () => void, delayMs: number) => () => void;

export class BufferedSeekRecovery {
  private cancelTimer: (() => void) | null = null;
  private media: SeekMedia | null = null;
  private onSeeked: (() => void) | null = null;

  constructor(
    private readonly schedule: Scheduler = (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  ) {}

  arm(media: SeekMedia, targetMs: number, recovered: () => void): void {
    this.cancel();
    const onSeeked = () => {
      if (!media.seeking) this.cancel();
    };
    this.media = media;
    this.onSeeked = onSeeked;
    media.addEventListener("seeked", onSeeked);
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.media = null;
      this.onSeeked = null;
      media.removeEventListener("seeked", onSeeked);
      if (nudgeStalledBufferedSeek(media, targetMs)) recovered();
    }, RECOVERY_DELAY_MS);
  }

  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.media && this.onSeeked) {
      this.media.removeEventListener("seeked", this.onSeeked);
    }
    this.media = null;
    this.onSeeked = null;
  }
}

export function nudgeStalledBufferedSeek(media: SeekMedia, targetMs: number): boolean {
  if (!media.seeking) return false;
  const safeTargetMs = Math.max(0, Math.round(targetMs));
  const range = bufferedRangeAt(media.buffered, safeTargetMs / 1000);
  if (!range) return false;
  const nudgedMs = Math.min(
    safeTargetMs + RECOVERY_NUDGE_MS,
    Math.floor(range.end * 1000 - RANGE_END_MARGIN_MS),
  );
  if (nudgedMs <= safeTargetMs) return false;
  media.currentTime = nudgedMs / 1000;
  return true;
}
