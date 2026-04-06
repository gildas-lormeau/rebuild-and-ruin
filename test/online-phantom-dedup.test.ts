/**
 * DedupChannel tests — verifies the atomic shouldSend/clear dedup mechanism
 * used for phantom and crosshair network suppression.
 *
 * Run with: deno test --no-check test/online-phantom-dedup.test.ts
 */

import {
  createDedupChannel,
} from "../src/shared/phantom-types.ts";
import { assert } from "jsr:@std/assert";
import type { ValidPlayerSlot } from "../src/shared/player-slot.ts";

Deno.test("DedupChannel.shouldSend returns false on duplicate", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal") === false, "duplicate should return false");
});

Deno.test("DedupChannel.shouldSend tracks players independently", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal");
  assert(ch.shouldSend(1 as ValidPlayerSlot, "5,3,normal") === true, "different player same key should return true");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal") === false, "player 0 unchanged should return false");
});

Deno.test("DedupChannel.shouldSend updates stored key on change", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "first");
  ch.shouldSend(0 as ValidPlayerSlot, "second");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "second") === false, "stored key should be 'second' after change");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "first") === true, "reverting to 'first' should be a change");
});
