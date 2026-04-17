/**
 * Ambient type declaration for the `soundfont-player` npm package
 * (which ships a minimal `.d.ts`-free interface). We use a narrow
 * subset: load an instrument by GM name, schedule notes with
 * { duration, gain, destination }, stop all active voices.
 *
 * Consumers must add a triple-slash `/// <reference path>` to pull
 * this file into Deno's per-file module graph.
 */

declare module "soundfont-player" {
  export interface PlayOptions {
    readonly duration?: number;
    readonly gain?: number;
    readonly attack?: number;
    readonly decay?: number;
    readonly sustain?: number;
    readonly release?: number;
  }

  export interface SoundfontPlayerNode {
    stop(when?: number): void;
  }

  export interface SoundfontPlayer {
    play(
      note: number | string,
      when?: number,
      opts?: PlayOptions,
    ): SoundfontPlayerNode;
    stop(): void;
  }

  export interface InstrumentOptions {
    readonly destination?: AudioNode;
    readonly soundfont?: "MusyngKite" | "FluidR3_GM";
    readonly format?: "mp3" | "ogg";
    readonly gain?: number;
    readonly nameToUrl?: (
      name: string,
      soundfont: string,
      format: string,
    ) => string;
  }

  const Soundfont: {
    instrument(
      ctx: AudioContext,
      name: string,
      opts?: InstrumentOptions,
    ): Promise<SoundfontPlayer>;
  };

  export default Soundfont;
}
