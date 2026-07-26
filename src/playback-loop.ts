import type { BufferPolicy } from "./buffer-policy";
import type { EventEmitter } from "./event-emitter";
import type { MediaSourceController } from "./media-source-controller";
import type { PlaybackClient } from "./playback-client";
import { PlaybackLoopTaskController } from "./playback-loop-task-controller";
import { currentTimeMs } from "./player-snapshot";
import type { SegmentScheduler } from "./segment-scheduler";
import type { LoadedSession } from "./session-loader";
import { refreshPlaybackWindow } from "./session-loader";

type PlaybackLoopArgs = {
  video: { currentTime: number; paused: boolean; readyState: number };
  playback: Pick<PlaybackClient, "position" | "prefetch" | "segments">;
  media: Pick<MediaSourceController, "bufferedRanges" | "endOfStream" | "trim">;
  scheduler: Pick<SegmentScheduler, "fill">;
  emitter: Pick<EventEmitter, "emit">;
  policy: BufferPolicy;
  session: () => LoadedSession | null;
  signal: () => AbortSignal;
  bufferedEndMs: () => number;
  error: (error: Error, context: PlaybackLoopFailureContext) => void;
};

export type PlaybackLoopFailureContext = {
  sessionId: string | null;
  signal: AbortSignal;
};

export class PlaybackLoop {
  private fillTimer: ReturnType<typeof setInterval> | null = null;
  private manifestTimer: ReturnType<typeof setInterval> | null = null;
  private fillTask: Promise<void> | null = null;
  private fillTaskRevision: number | null = null;
  private refreshTask: Promise<void> | null = null;
  private taskController = new PlaybackLoopTaskController();
  private revision = 0;
  private active = false;

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
    const bufferGoalMs = this.args.policy.bufferGoalMs;
    const goalMs = currentMs + bufferGoalMs + this.liveStallRecoveryMs(bufferGoalMs);
    await this.args.scheduler.fill(session.manifest, currentMs, goalMs, signal);
    this.ensureCurrent(revision, signal);
    if (
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
        await this.args.scheduler.fill(session.manifest, currentMs, goalMs, signal);
        this.ensureCurrent(revision, signal);
      }
    }
    await this.args.media.trim(currentMs, this.args.policy.backBufferMs);
    this.ensureCurrent(revision, signal);
    const bufferedEndMs = this.args.bufferedEndMs();
    this.args.emitter.emit({
      type: "buffer",
      currentTimeMs: currentMs,
      bufferedEndMs,
    });
    if (session.manifest.endOfStream && this.args.media.endOfStream()) {
      this.stop();
      return;
    }
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
    const thresholdMs = refreshThresholdMs(this.args.policy.bufferGoalMs);
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

function refreshThresholdMs(bufferGoalMs: number): number {
  return Math.min(bufferGoalMs, Math.max(5_000, Math.round((bufferGoalMs * 2) / 3)));
}

const HAVE_FUTURE_DATA = 3;
