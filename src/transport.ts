import { bufferSeconds, type PlaybackPolicyInput, resolvePlaybackPolicy } from "./playback-policy";

const MEDIA_HANDLE_PATTERN = /\/media\/(m1_[A-Za-z0-9_-]{24})$/;

/** Opaque provider media URL accepted by the TypeType media-handle route. */
export type MediaHandleUrl = string & { readonly __mediaHandle: unique symbol };

/** Minimal fetch request shape shared by HLS transport implementations. */
export type TransportFetchRequest = {
  url: string;
  [key: string]: unknown;
};

/** Initialization parameters passed through by an HLS transport. */
export type TransportRequestInit = RequestInit;

/** A transport loader class accepted by HLS engines. */
export type TransportLoader = unknown;

/** Generic configuration returned for an HLS engine. */
export type TransportConfig = Record<string, unknown>;

/** Inputs used to create a deterministic HLS transport configuration. */
export type HlsTransportOptions<TLoader extends TransportLoader> = {
  FetchLoader: TLoader;
  playbackKey?: string;
  policy?: PlaybackPolicyInput;
  crypto?: Crypto;
};

/** DASH buffer and retry settings, keyed by the names used by dash.js. */
export type DashStreamingSettings = {
  buffer: {
    bufferTimeAtTopQuality: number;
    bufferTimeAtTopQualityLongForm: number;
    bufferToKeep: number;
  };
  retryAttempts: {
    MPD: number;
    MediaSegment: number;
    InitializationSegment: number;
    IndexSegment: number;
  };
  retryIntervals: {
    MPD: number;
    MediaSegment: number;
    InitializationSegment: number;
    IndexSegment: number;
  };
};

/** Detect an opaque provider media handle that requires a playback-generation query. */
export function isMediaHandleUrl(url: string): boolean {
  return MEDIA_HANDLE_PATTERN.test(url);
}

/** Version an opaque media-handle request without changing its media identity. */
export function hlsRequestUrl(url: string, playbackKey: string): string {
  if (!isMediaHandleUrl(url)) return url;
  const absolute = URL.canParse(url);
  const parsed = new URL(url, "https://typetype.invalid");
  parsed.searchParams.set("playback", playbackKey);
  return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
}

/** Create a bounded playback key even when the secure randomness API is absent. */
export function createHlsPlaybackKey(cryptoApi: Crypto | undefined = globalThis.crypto): string {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    return Array.from(cryptoApi.getRandomValues(new Uint32Array(4)), (value) =>
      value.toString(16).padStart(8, "0"),
    ).join("-");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Create the low-level startup and buffering contract for an HLS MSE engine. */
export function createHlsConfig<TConfig extends TransportConfig, TLoader extends TransportLoader>(
  options: HlsTransportOptions<TLoader>,
): Partial<TConfig> {
  const policy = resolvePlaybackPolicy(options.policy);
  let requestSequence = 0;
  const playbackKey = options.playbackKey ?? createHlsPlaybackKey(options.crypto);
  return {
    abrEwmaDefaultEstimate: 1_000_000,
    backBufferLength: bufferSeconds(policy.backBufferMs),
    capLevelToPlayerSize: true,
    fetchSetup: (context: TransportFetchRequest, initParams: TransportRequestInit) =>
      new Request(hlsRequestUrl(context.url, `${playbackKey}-${requestSequence++}`), initParams),
    liveMaxLatencyDuration: bufferSeconds(policy.liveMaxLatencyMs),
    liveSyncDuration: bufferSeconds(policy.liveTargetLatencyMs),
    loader: options.FetchLoader,
    maxBufferLength: bufferSeconds(policy.steadyBufferMs),
    maxLiveSyncPlaybackRate: policy.liveCatchupMaxRate,
    maxMaxBufferLength: bufferSeconds(policy.maxBufferMs),
    progressive: true,
    startFragPrefetch: true,
    startLevel: 0,
    testBandwidth: false,
  } as unknown as Partial<TConfig>;
}

/** Create the DASH MSE buffering and retry contract from the shared policy. */
export function createDashSettings(policyInput: PlaybackPolicyInput = {}): DashStreamingSettings {
  const policy = resolvePlaybackPolicy(policyInput);
  return {
    buffer: {
      bufferTimeAtTopQuality: bufferSeconds(policy.steadyBufferMs),
      bufferTimeAtTopQualityLongForm: bufferSeconds(policy.steadyBufferMs),
      bufferToKeep: bufferSeconds(policy.backBufferMs),
    },
    retryAttempts: {
      MPD: policy.manifestAttempts,
      MediaSegment: policy.mediaAttempts,
      InitializationSegment: policy.mediaAttempts,
      IndexSegment: policy.mediaAttempts,
    },
    retryIntervals: {
      MPD: policy.retryIntervalMs,
      MediaSegment: policy.retryIntervalMs,
      InitializationSegment: policy.retryIntervalMs,
      IndexSegment: policy.retryIntervalMs,
    },
  };
}
