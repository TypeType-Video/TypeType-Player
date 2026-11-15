import { refreshThresholdMs } from "./playback-rate";

const HIGH_RTT_THRESHOLD_MS = 400;
const LOW_RTT_THRESHOLD_MS = 250;
const MAX_EARLY_REFRESH_LEAD_MS = 2_000;
const MIN_BUFFER_HEADROOM_MS = 1_000;
const LOW_RTT_RECOVERY_SAMPLES = 3;

/**
 * Computes when to trigger the next manifest refresh without exceeding bufferGoalMs.
 * Learned RTT persists across seeks and resets to baseline once consecutive low-RTT replies arrive.
 */
export class AdaptiveRefreshThreshold {
  private smoothedRttMs = 0;
  private consecutiveLowRtt = 0;

  /** Records a completed window control-plane round-trip measurement in milliseconds. */
  observeControlRtt(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    if (rttMs >= HIGH_RTT_THRESHOLD_MS) {
      this.consecutiveLowRtt = 0;
      this.smoothedRttMs =
        this.smoothedRttMs > 0 ? Math.round((this.smoothedRttMs + rttMs) / 2) : Math.round(rttMs);
      return;
    }
    if (this.smoothedRttMs <= 0) return;
    if (rttMs <= LOW_RTT_THRESHOLD_MS) {
      this.consecutiveLowRtt += 1;
      if (this.consecutiveLowRtt >= LOW_RTT_RECOVERY_SAMPLES) {
        this.smoothedRttMs = Math.round((this.smoothedRttMs * 3 + rttMs) / 4);
        if (this.smoothedRttMs < HIGH_RTT_THRESHOLD_MS) {
          this.smoothedRttMs = 0;
          this.consecutiveLowRtt = 0;
        }
      }
      return;
    }
    this.consecutiveLowRtt = 0;
  }

  /** Returns the effective remaining-buffer threshold below which VOD refreshes start early. */
  thresholdMs(bufferGoalMs: number, isLive: boolean): number {
    const baseThresholdMs = refreshThresholdMs(bufferGoalMs);
    if (isLive || this.smoothedRttMs < HIGH_RTT_THRESHOLD_MS) {
      return baseThresholdMs;
    }
    const maxLeadThresholdMs = bufferGoalMs - MIN_BUFFER_HEADROOM_MS;
    if (maxLeadThresholdMs <= baseThresholdMs) {
      return baseThresholdMs;
    }
    const earlyBonusMs = Math.min(MAX_EARLY_REFRESH_LEAD_MS, Math.round(this.smoothedRttMs));
    return Math.min(maxLeadThresholdMs, baseThresholdMs + earlyBonusMs);
  }
}
