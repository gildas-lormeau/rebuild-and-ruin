/**
 * Ambient type declaration for the `jsfxr` npm package (which ships no
 * `.d.ts`). Consumers must add a triple-slash `/// <reference path>` to
 * pull this file into Deno's per-file module graph — tsc finds it via
 * the tsconfig `include` glob, but Deno only follows explicit edges.
 */

declare module "jsfxr" {
  interface SfxrParams {
    readonly wave_type?: number;
    readonly p_env_attack?: number;
    readonly p_env_sustain?: number;
    readonly p_env_punch?: number;
    readonly p_env_decay?: number;
    readonly p_base_freq?: number;
    readonly p_freq_limit?: number;
    readonly p_freq_ramp?: number;
    readonly p_freq_dramp?: number;
    readonly p_vib_strength?: number;
    readonly p_vib_speed?: number;
    readonly p_arp_mod?: number;
    readonly p_arp_speed?: number;
    readonly p_duty?: number;
    readonly p_duty_ramp?: number;
    readonly p_repeat_speed?: number;
    readonly p_pha_offset?: number;
    readonly p_pha_ramp?: number;
    readonly p_lpf_freq?: number;
    readonly p_lpf_ramp?: number;
    readonly p_lpf_resonance?: number;
    readonly p_hpf_freq?: number;
    readonly p_hpf_ramp?: number;
    readonly sound_vol?: number;
    readonly sample_rate?: number;
    readonly sample_size?: number;
  }

  interface SfxrWave {
    readonly dataURI: string;
    getAudio(): HTMLAudioElement;
  }

  export const sfxr: {
    toWave(params: SfxrParams): SfxrWave;
    toAudio(params: SfxrParams): HTMLAudioElement;
    toBuffer(params: SfxrParams): {
      buffer: Float32Array;
      normalized: Float32Array;
    };
    play(params: SfxrParams): HTMLAudioElement;
    b58encode(params: SfxrParams): string;
    b58decode(encoded: string): SfxrParams;
  };
}
