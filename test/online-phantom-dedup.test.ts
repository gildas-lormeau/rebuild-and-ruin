/**
 * Phantom dedup tests: cannonPhantomKey, piecePhantomKey, DedupChannel.
 *
 * Verifies that the dedup key functions produce stable keys and that
 * DedupChannel.shouldSend() correctly detects first sends, duplicates, and changes.
 *
 * Run with: bun test/online-phantom-dedup.test.ts
 */

import type { ValidPlayerSlot } from "../src/game-constants.ts";
import { interpolateToward, toCannonMode } from "../src/online-types.ts";
import {
  cannonPhantomKey,
  type CannonPhantom,
  createDedupChannel,
  filterAlivePhantoms,
  piecePhantomKey,
  type PiecePhantom,
} from "../src/phantom-types.ts";
import { CannonMode } from "../src/types.ts";
import { assert, runTests, test } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// cannonPhantomKey
// ---------------------------------------------------------------------------

test("cannonPhantomKey produces row,col,mode,valid format", () => {
  const phantom: CannonPhantom = { row: 5, col: 3, valid: true, mode: CannonMode.NORMAL, playerId: 0 as ValidPlayerSlot };
  const key = cannonPhantomKey(phantom);
  assert(key === "5,3,normal,1", `expected "5,3,normal,1", got "${key}"`);
});

test("cannonPhantomKey differs by mode", () => {
  const base: CannonPhantom = { row: 5, col: 3, valid: true, mode: CannonMode.NORMAL, playerId: 0 as ValidPlayerSlot };
  const superP: CannonPhantom = { ...base, mode: CannonMode.SUPER };
  const balloonP: CannonPhantom = { ...base, mode: CannonMode.BALLOON };
  assert(cannonPhantomKey(base) !== cannonPhantomKey(superP), "NORMAL and SUPER should produce different keys");
  assert(cannonPhantomKey(base) !== cannonPhantomKey(balloonP), "NORMAL and BALLOON should produce different keys");
  assert(cannonPhantomKey(superP) !== cannonPhantomKey(balloonP), "SUPER and BALLOON should produce different keys");
});

test("cannonPhantomKey differs by position", () => {
  const a: CannonPhantom = { row: 5, col: 3, valid: true, mode: CannonMode.NORMAL, playerId: 0 as ValidPlayerSlot };
  const b: CannonPhantom = { ...a, row: 6 };
  const c: CannonPhantom = { ...a, col: 4 };
  assert(cannonPhantomKey(a) !== cannonPhantomKey(b), "different row should produce different key");
  assert(cannonPhantomKey(a) !== cannonPhantomKey(c), "different col should produce different key");
});

test("cannonPhantomKey differs by valid flag", () => {
  const a: CannonPhantom = { row: 5, col: 3, valid: true, mode: CannonMode.NORMAL, playerId: 0 as ValidPlayerSlot };
  const b: CannonPhantom = { ...a, valid: false };
  assert(cannonPhantomKey(a) !== cannonPhantomKey(b), "different valid should produce different key");
});

test("cannonPhantomKey ignores playerId", () => {
  const a: CannonPhantom = { row: 5, col: 3, valid: true, mode: CannonMode.NORMAL, playerId: 0 as ValidPlayerSlot };
  const b: CannonPhantom = { ...a, playerId: 2 as ValidPlayerSlot };
  assert(cannonPhantomKey(a) === cannonPhantomKey(b), "playerId should not affect key");
});

// ---------------------------------------------------------------------------
// piecePhantomKey
// ---------------------------------------------------------------------------

test("piecePhantomKey encodes position and offsets", () => {
  const phantom: PiecePhantom = { row: 10, col: 20, offsets: [[0, 0], [1, 0], [0, 1]], playerId: 0 as ValidPlayerSlot, valid: true };
  const key = piecePhantomKey(phantom);
  assert(key === "10,20,1,0:0;1:0;0:1", `expected "10,20,1,0:0;1:0;0:1", got "${key}"`);
});

test("piecePhantomKey differs by offset shape", () => {
  const a: PiecePhantom = { row: 10, col: 20, offsets: [[0, 0], [1, 0]], playerId: 0 as ValidPlayerSlot, valid: true };
  const b: PiecePhantom = { row: 10, col: 20, offsets: [[0, 0], [0, 1]], playerId: 0 as ValidPlayerSlot, valid: true };
  assert(piecePhantomKey(a) !== piecePhantomKey(b), "different offsets should produce different keys");
});

test("piecePhantomKey differs by position", () => {
  const a: PiecePhantom = { row: 10, col: 20, offsets: [[0, 0]], playerId: 0 as ValidPlayerSlot, valid: true };
  const b: PiecePhantom = { row: 11, col: 20, offsets: [[0, 0]], playerId: 0 as ValidPlayerSlot, valid: true };
  assert(piecePhantomKey(a) !== piecePhantomKey(b), "different position should produce different key");
});

test("piecePhantomKey differs by valid flag", () => {
  const a: PiecePhantom = { row: 10, col: 20, offsets: [[0, 0]], playerId: 0 as ValidPlayerSlot, valid: true };
  const b: PiecePhantom = { row: 10, col: 20, offsets: [[0, 0]], playerId: 0 as ValidPlayerSlot, valid: false };
  assert(piecePhantomKey(a) !== piecePhantomKey(b), "different valid flag should produce different key");
});

// ---------------------------------------------------------------------------
// DedupChannel
// ---------------------------------------------------------------------------

test("DedupChannel.shouldSend returns true on first send", () => {
  const ch = createDedupChannel();
  assert(ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal") === true, "first send should return true");
});

test("DedupChannel.shouldSend returns false on duplicate", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal") === false, "duplicate should return false");
});

test("DedupChannel.shouldSend returns true when key changes", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "6,3,normal") === true, "changed key should return true");
});

test("DedupChannel.shouldSend tracks players independently", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal");
  assert(ch.shouldSend(1 as ValidPlayerSlot, "5,3,normal") === true, "different player same key should return true");
  assert(ch.shouldSend(0 as ValidPlayerSlot, "5,3,normal") === false, "player 0 unchanged should return false");
});

test("DedupChannel.shouldSend updates stored key on change", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "first");
  ch.shouldSend(0 as ValidPlayerSlot, "second");
  // After two changes, a third call with "second" should be a dup
  assert(ch.shouldSend(0 as ValidPlayerSlot, "second") === false, "stored key should be 'second' after change");
  // And "first" should now be seen as changed
  assert(ch.shouldSend(0 as ValidPlayerSlot, "first") === true, "reverting to 'first' should be a change");
});

test("DedupChannel.clear resets all tracked state", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerSlot, "key-a");
  ch.shouldSend(1 as ValidPlayerSlot, "key-b");
  ch.clear();
  assert(ch.shouldSend(0 as ValidPlayerSlot, "key-a") === true, "after clear, same key should return true again");
  assert(ch.shouldSend(1 as ValidPlayerSlot, "key-b") === true, "after clear, same key should return true again");
});

// ---------------------------------------------------------------------------
// toCannonMode
// ---------------------------------------------------------------------------

test("toCannonMode parses valid modes", () => {
  assert(toCannonMode("normal") === CannonMode.NORMAL, "should parse normal");
  assert(toCannonMode("super") === CannonMode.SUPER, "should parse super");
  assert(toCannonMode("balloon") === CannonMode.BALLOON, "should parse balloon");
});

test("toCannonMode defaults to NORMAL for invalid input", () => {
  assert(toCannonMode("invalid") === CannonMode.NORMAL, "invalid should default to NORMAL");
  assert(toCannonMode(undefined) === CannonMode.NORMAL, "undefined should default to NORMAL");
  assert(toCannonMode("") === CannonMode.NORMAL, "empty string should default to NORMAL");
});

// ---------------------------------------------------------------------------
// filterAlivePhantoms
// ---------------------------------------------------------------------------

test("filterAlivePhantoms removes eliminated player phantoms", () => {
  const phantoms = [
    { playerId: 0 as ValidPlayerSlot, row: 1, col: 1 },
    { playerId: 1 as ValidPlayerSlot, row: 2, col: 2 },
    { playerId: 2 as ValidPlayerSlot, row: 3, col: 3 },
  ];
  const players = [
    { eliminated: false },
    { eliminated: true },
    { eliminated: false },
  ];
  const result = filterAlivePhantoms(phantoms, players);
  assert(result.length === 2, `expected 2 alive phantoms, got ${result.length}`);
  assert(result[0]!.playerId === 0, "first should be player 0");
  assert(result[1]!.playerId === 2, "second should be player 2");
});

test("filterAlivePhantoms keeps all when none eliminated", () => {
  const phantoms = [{ playerId: 0 as ValidPlayerSlot, row: 1, col: 1 }, { playerId: 1 as ValidPlayerSlot, row: 2, col: 2 }];
  const players = [{ eliminated: false }, { eliminated: false }];
  const result = filterAlivePhantoms(phantoms, players);
  assert(result.length === 2, "all phantoms should be kept");
});

// ---------------------------------------------------------------------------
// interpolateToward
// ---------------------------------------------------------------------------

test("interpolateToward snaps when close enough", () => {
  const pos = { x: 99, y: 99 };
  interpolateToward(pos, 100, 100, 500, 1);
  assert(pos.x === 100 && pos.y === 100, `expected (100,100), got (${pos.x},${pos.y})`);
});

test("interpolateToward moves partially when far away", () => {
  const pos = { x: 0, y: 0 };
  interpolateToward(pos, 100, 0, 10, 1); // speed=10, dt=1 → move 10px
  assert(pos.x === 10, `expected x=10, got ${pos.x}`);
  assert(pos.y === 0, `expected y=0, got ${pos.y}`);
});

test("interpolateToward does nothing when already at target", () => {
  const pos = { x: 50, y: 50 };
  interpolateToward(pos, 50, 50, 100, 1);
  assert(pos.x === 50 && pos.y === 50, "should not move when at target");
});

await runTests("Online phantom dedup & helpers");
