import { PlaybackLoopTaskController } from "./playback-loop-task-controller";
import type { PlaybackLoopArgs, PlaybackLoopFailureContext } from "./playback-loop-types";
import { rateAwareBufferGoalMs, refreshThresholdMs } from "./playback-rate";
import { SegmentGenerationConflictError } from "./playback-window-error";
import { currentTimeMs } from "./player-snapshot";
import type { SegmentFillResult } from "./segment-scheduler";
import type { LoadedSession } from "./session-loader";
import { refreshPlaybackWindow } from "./session-loader";

export type { PlaybackLoopFailureContext } from "./playback-loop-types";

export class PlaybackLoop {
  private fillTimer: ReturnType<typeof setInterval> | null = null;
  private manifestTimer: ReturnType<typeof setInterval> | null = null;
  private fillTask: Promise<void> | null = null;
  private fillTaskRevision: number | null = null;
  private refreshTask: Promise<void> | null = null;
  private taskController = new PlaybackLoopTaskController();
  private revision = 0;
  private active = false;
  private quotaGoalLimitMs: number | null = null;

  constructor(private readonly args: PlaybackLoopArgs) {}

  start(): void {
    this.stop();
    this.active = true;
    const revision = this.revision;
    this.fillTimer = setInterval(() => this.requestFill(revision), this.args.policy.pollIntervalMs);
    this.manifestTimer = setInterval(
      () => this.requestManifestRefreshIfNeeded(revision),
      this.args.policy.manifestRefreshMs,
    );
  }

  stop(): void {
    this.active = false;
    this.revision += 1;
    this.taskController.stop();
    if (this.fillTimer) clearInterval(this.fillTimer);
    if (this.manifestTimer) clearInterval(this.manifestTimer);
    this.fillTimer = null;
    this.manifestTimer = null;
  }

  async quiesce(): Promise<void> {
    this.stop();
    while (this.fillTask || this.refreshTask) {
      const tasks = [this.fillTask, this.refreshTask].filter(
        (task): task is Promise<void> => task !== null,
      );
      await Promise.allSettled(tasks);
    }
  }

  wake(): void {
    if (!this.active) return;
    this.requestFill(this.revision);
  }

  fillOnce(revision = this.revision): Promise<void> {
    if (revision !== this.revision) return Promise.resolve();
    if (this.fillTask) {
      return this.fillTaskRevision === revision ? this.fillTask : Promise.resolve();
    }
    const session = this.args.session();
    if (!session) return Promise.resolve();
    const signal = this.taskController.signal(this.args.signal());
    const task = this.performFill(session, signal, revision);
    this.fillTask = task;
    this.fillTaskRevision = revision;
    const clear = () => {
      if (this.fillTask === task) {
        this.fillTask = null;
        this.fillTaskRevision = null;
      }
    };
    void task.then(clear, clear);
    return task;
  }

  private async performFill(
    session: LoadedSession,
    signal: AbortSignal,
    revision: number,
  ): Promise<void> {
    const currentMs = currentTimeMs(this.args.video);
    const trim = this.args.media.trim(currentMs, this.args.policy.backBufferMs);
    trim.catch(() => undefined);
    const bufferGoalMs = this.quotaLimitedGoalMs(
      rateAwareBufferGoalMs(this.args.policy.bufferGoalMs, this.args.playbackRate?.() ?? 1),
    );
    const goalMs = currentMs + bufferGoalMs + this.liveStallRecoveryMs(bufferGoalMs);
    let result = await this.fillCurrentGeneration(session, currentMs, goalMs, signal, revision);
    this.ensureCurrent(revision, signal);
    if (
      result !== "deferred" &&
      !session.manifest.endOfStream &&
      this.args.bufferedEndMs() < currentMs + refreshThresholdMs(bufferGoalMs)
    ) {
      this.requestManifestRefresh(revision);
      const refresh = this.refreshTask;
      if (refresh) {
        try {
          await refresh;
        } catch {
          return;
        }
        this.ensureCurrent(revision, signal);
        result = await this.fillCurrentGeneration(session, currentMs, goalMs, signal, revision);
        this.ensureCurrent(revision, signal);
      }
    }
    await trim;
    this.ensureCurrent(revision, signal);
    if (result === "deferred") this.shrinkQuotaGoal(bufferGoalMs);
    const bufferedEndMs = this.args.bufferedEndMs();
    this.args.emitter.emit({
      type: "buffer",
      currentTimeMs: currentMs,
      bufferedEndMs,
    });
    if (result !== "deferred" && session.manifest.endOfStream && this.args.media.endOfStream()) {
      this.stop();
      return;
    }
  }

  private async fillCurrentGeneration(
    session: LoadedSession,
    currentMs: number,
    goalMs: number,
    signal: AbortSignal,
    revision: number,
  ): Promise<SegmentFillResult> {
    for (let refreshes = 0; ; refreshes += 1) {
      try {
        return await this.args.scheduler.fill(session.manifest, currentMs, goalMs, signal);
      } catch (error) {
        if (!(error instanceof SegmentGenerationConflictError)) throw error;
        if (refreshes >= MAX_GENERATION_REFRESHES) throw error;
      }
      this.ensureCurrent(revision, signal);
      this.requestManifestRefresh(revision);
      try {
        await this.refreshTask;
      } catch {
        throw new DOMException("Operation aborted", "AbortError");
      }
      this.ensureCurrent(revision, signal);
    }
  }

  private quotaLimitedGoalMs(goalMs: number): number {
    return Math.min(goalMs, this.quotaGoalLimitMs ?? goalMs);
  }

  private shrinkQuotaGoal(goalMs: number): void {
    this.quotaGoalLimitMs = Math.max(MIN_QUOTA_BUFFER_GOAL_MS, Math.round(goalMs / 2));
  }

  private requestFill(revision: number): void {
    const context = this.failureContext();
    void this.fillOnce(revision).catch((error) => this.fail(error, context, revision));
  }

  private async refreshManifest(session: LoadedSession, signal: AbortSignal): Promise<void> {
    const revision = this.revision;
    await refreshPlaybackWindow(
      this.args.playback,
      this.args.media,
      session,
      this.args.policy,
      () => currentTimeMs(this.args.video),
      signal,
      this.args.playbackRate,
    );
    this.ensureCurrent(revision, signal);
  }

  private requestManifestRefresh(revision: number): void {
    const session = this.args.session();
    if (!session || revision !== this.revision || this.refreshTask) return;
    const operationSignal = this.args.signal();
    const signal = this.taskController.signal(operationSignal);
    const task = this.refreshManifest(session, signal);
    this.refreshTask = task;
    void task.catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.fail(
        error,
        { sessionId: session.response.sessionId, signal: operationSignal },
        revision,
      );
    });
    const clear = () => {
      if (this.refreshTask === task) this.refreshTask = null;
    };
    void task.then(clear, clear);
  }

  private requestManifestRefreshIfNeeded(revision: number): void {
    if (revision !== this.revision) return;
    const currentMs = currentTimeMs(this.args.video);
    const thresholdMs = refreshThresholdMs(
      rateAwareBufferGoalMs(this.args.policy.bufferGoalMs, this.args.playbackRate?.() ?? 1),
    );
    const session = this.args.session();
    const waitingForLiveData = this.waitingForLiveData(session);
    if (waitingForLiveData || this.args.bufferedEndMs() < currentMs + thresholdMs) {
      this.requestManifestRefresh(revision);
    }
  }

  private liveStallRecoveryMs(bufferGoalMs: number): number {
    return this.waitingForLiveData(this.args.session()) ? refreshThresholdMs(bufferGoalMs) : 0;
  }

  private waitingForLiveData(session: LoadedSession | null): boolean {
    return (
      session?.manifest.live?.active === true &&
      !this.args.video.paused &&
      this.args.video.readyState < HAVE_FUTURE_DATA
    );
  }

  private failureContext(): PlaybackLoopFailureContext {
    return {
      sessionId: this.args.session()?.response.sessionId ?? null,
      signal: this.args.signal(),
    };
  }

  private fail(error: unknown, context: PlaybackLoopFailureContext, revision: number): void {
    if (revision !== this.revision || context.signal.aborted) return;
    this.stop();
    this.args.error(error instanceof Error ? error : new Error("SABR playback failed"), context);
  }

  private ensureCurrent(revision: number, signal: AbortSignal): void {
    if (revision !== this.revision || signal.aborted) {
      throw new DOMException("Operation aborted", "AbortError");
    }
  }
}

const HAVE_FUTURE_DATA = 3;
const MAX_GENERATION_REFRESHES = 2;
const MIN_QUOTA_BUFFER_GOAL_MS = 4_000;
