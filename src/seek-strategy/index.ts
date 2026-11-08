import type { PlayerSeekMode } from "../types";
import { NativeSeekStrategy } from "./native-seek-strategy";
import { PrerollSeekStrategy } from "./preroll-seek-strategy";
import type { SeekStrategy } from "./types";

export { NativeSeekStrategy } from "./native-seek-strategy";
export { PrerollSeekStrategy } from "./preroll-seek-strategy";
export * from "./types";

/** Factory function creating a SeekStrategy instance corresponding to the requested PlayerSeekMode. */
export function createSeekStrategy(mode?: PlayerSeekMode): SeekStrategy {
  if (mode === "preroll") {
    return new PrerollSeekStrategy();
  }
  return new NativeSeekStrategy();
}
