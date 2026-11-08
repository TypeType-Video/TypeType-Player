import { decodeStartMs, runDecodePreroll } from "../decode-preroll";
import { tryResumePlayback } from "../media-playback";
import type { PlayerSeekMode } from "../types";
import type { SeekAlignmentContext, SeekExecutionContext, SeekStrategy } from "./types";

export class PrerollSeekStrategy implements SeekStrategy {
  readonly mode: PlayerSeekMode = "preroll";

  alignSessionPosition(ctx: SeekAlignmentContext): void {
    const startMs = decodeStartMs(ctx.manifest, ctx.resolvedStartTimeMs);
    const decodesToTarget =
      ctx.resolvedStartTimeMs > startMs && (ctx.finalizePausedSeek || ctx.shouldResume);
    if (decodesToTarget) {
      ctx.transientMediaState.holdForPreroll();
    }
    ctx.video.currentTime = startMs / 1000;
  }

  async executeSessionSeek(ctx: SeekExecutionContext): Promise<number | null> {
    const startMs = decodeStartMs(ctx.manifest, ctx.resolvedStartTimeMs);
    if (ctx.resolvedStartTimeMs > startMs) {
      if (ctx.shouldResume) {
        await this.runPreroll(ctx, true, false);
        return null;
      }
      if (ctx.finalizePausedSeek) {
        await this.runPreroll(ctx, false, true);
        return null;
      }
      return ctx.resolvedStartTimeMs;
    }
    if (ctx.shouldResume) {
      if (ctx.resolvedStartTimeMs > 0) {
        await this.runPreroll(ctx, Boolean(ctx.handoff), true);
      }
      await tryResumePlayback(ctx.video);
      return null;
    }
    if (ctx.finalizePausedSeek && ctx.resolvedStartTimeMs > 0) {
      await this.runPreroll(ctx, false, true);
      return null;
    }
    return null;
  }

  private async runPreroll(
    ctx: SeekExecutionContext,
    resumePlayback: boolean,
    requireFrame: boolean,
  ): Promise<void> {
    await ctx.fillBuffer();
    return runDecodePreroll(
      ctx.video,
      ctx.resolvedStartTimeMs,
      resumePlayback,
      ctx.signal,
      requireFrame,
      ctx.transientMediaState,
    );
  }
}
