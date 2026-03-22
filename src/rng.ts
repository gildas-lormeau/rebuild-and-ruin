/**
 * Seeded pseudo-random number generator (Mulberry32).
 *
 * Drop-in replacement for Math.random() that produces reproducible
 * sequences from a 32-bit seed.  Each AI player gets its own Rng
 * so games can be replayed by logging seeds.
 */

export class Rng {
  private state: number;
  /** The seed this Rng was created with. Log it to reproduce a game. */
  readonly seed: number;

  constructor(seed?: number) {
    this.seed = seed ?? (Math.random() * 0x100000000) >>> 0;
    this.state = this.seed;
  }

  /** Returns a float in [0, 1), like Math.random(). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Random integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Returns true with the given probability (0–1). */
  bool(prob = 0.5): boolean {
    return this.next() < prob;
  }

  private randomIndex(length: number): number {
    return Math.floor(this.next() * length);
  }

  /** Pick a random element from an array. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.randomIndex(arr.length)]!;
  }

  /** Fisher-Yates shuffle (in-place). */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.randomIndex(i + 1);
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  }
}
