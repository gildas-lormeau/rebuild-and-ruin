/**
 * Banner sub-system — phase transition banners (show + tick).
 *
 * Wraps phase-banner.ts primitives with runtime state access,
 * camera unzoom, haptics, and sound.
 */

import { snapshotCastles, snapshotEntities } from "../game/index.ts";
import { BANNER_DURATION } from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { GameState } from "../shared/core/types.ts";
import { fireOnce } from "../shared/platform/utils.ts";
import type { EntityOverlay } from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { type BannerState, createBannerState } from "./runtime-contracts.ts";
import {
  assertStateReady,
  type RuntimeState,
  setMode,
} from "./runtime-state.ts";

interface ShowBannerDeps {
  banner: BannerState;
  state: GameState;
  battleAnim: { territory: Set<number>[]; walls: Set<number>[] };
  text: string;
  subtitle?: string;
  onDone: () => void;
  /** When true, snapshot old castles/territory/walls before transitioning
   *  so the banner can show a before/after visual comparison. */
  preservePrevScene?: boolean;
  newBattle?: { territory: Set<number>[]; walls: Set<number>[] };
  setModeBanner: () => void;
}

interface BannerSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly clearPhaseZoom: () => void;
  readonly log: (msg: string) => void;
  readonly haptics: { phaseChange: () => void };
  readonly sound: { phaseStart: () => void };
  readonly render: () => void;
}

interface BannerSystem {
  /** Show a phase transition banner.
   *  @param text — Banner text
   *  @param onDone — Called once when banner animation completes
   *  @param preservePrevScene — If true, render old scene behind the banner (for before/after comparison)
   *  @param newBattle — Battle territory/walls snapshot for the "after" scene. Only used when preservePrevScene is true; ignored otherwise.
   *  @param subtitle — Optional smaller text below the main banner */
  showBanner: (
    text: string,
    onDone: () => void,
    preservePrevScene?: boolean,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) => void;
  tickBanner: (dt: number) => void;
  /** Clear stale snapshot data (wallsBeforeSweep, prevCastles) — called
   *  when selection state is reset (e.g. after losing a life). */
  clearSnapshots: () => void;
  /** Reset banner state for game restart / rematch. */
  reset: () => void;
  /** Store entity snapshot for banner before/after comparison. */
  setPrevEntities: (entities: EntityOverlay) => void;
}

export function createBannerSystem(deps: BannerSystemDeps): BannerSystem {
  const { runtimeState, clearPhaseZoom, log, haptics, sound, render } = deps;
  // True between showBanner() and the first tick. Originally introduced
  // to defer `bannerStart` until a mid-frame `banner.text/modifierDiff`
  // overwrite (host battle transition) had settled — that swap is gone
  // now (the host inspects modifierDiff before calling showBanner, same
  // shape as the watcher), but the deferral is kept as a one-tick dedup
  // so consecutive showBanner calls in the same tick collapse into a
  // single bannerStart event for the final content.
  let pendingStartEvent = false;

  function showBanner(
    text: string,
    onDone: () => void,
    preservePrevScene = false,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) {
    // Unzoom before banner so the full map is visible during transition
    assertStateReady(runtimeState);
    clearPhaseZoom();
    if (runtimeState.banner.active) {
      log(
        `showBanner "${text}" while banner "${runtimeState.banner.text}" is still active`,
      );
    }
    showBannerTransition({
      banner: runtimeState.banner,
      state: runtimeState.state,
      battleAnim: runtimeState.battleAnim,
      text,
      subtitle,
      onDone,
      preservePrevScene,
      newBattle,
      setModeBanner: () => {
        setMode(runtimeState, Mode.BANNER);
      },
    });
    pendingStartEvent = true;
    haptics.phaseChange();
    sound.phaseStart();
  }

  function tickBanner(dt: number) {
    const banner = runtimeState.banner;
    const state = runtimeState.state;

    // Emit bannerStart on the first tick after showBanner — content may have
    // been mutated mid-frame (e.g. battle banner → modifier reveal), so we
    // read the final state here.
    if (pendingStartEvent) {
      pendingStartEvent = false;
      emitGameEvent(state.bus, GAME_EVENT.BANNER_START, {
        text: banner.text,
        subtitle: banner.subtitle,
        phase: state.phase,
        round: state.round,
        modifierId: banner.modifierDiff?.id,
        changedTiles: banner.modifierDiff?.changedTiles,
      });
    }

    banner.progress = Math.min(1, banner.progress + dt / BANNER_DURATION);
    render();

    if (banner.progress < 1) return;

    const endedText = banner.text;
    banner.prevCastles = undefined;
    banner.prevTerritory = undefined;
    banner.prevWalls = undefined;
    banner.prevEntities = undefined;
    banner.newTerritory = undefined;
    banner.newWalls = undefined;
    banner.modifierDiff = undefined;
    banner.active = false;
    emitGameEvent(state.bus, GAME_EVENT.BANNER_END, {
      text: endedText,
      phase: state.phase,
      round: state.round,
    });
    // Invoke the completion callback exactly once, THEN null the field to
    // prevent re-entry if tickBanner runs again this frame. See shared/utils.ts
    // for the fireOnce contract. New dialog subsystems: pick one of the three
    // documented callback patterns (runtime-types.ts above ScoreDeltaSystem):
    // stored-on-state (banner/score delta, this file), method (life-lost), or
    // local closure (upgrade-pick).
    fireOnce(banner, "callback", "banner.callback");
  }

  function clearSnapshots(): void {
    runtimeState.banner.wallsBeforeSweep = undefined;
    runtimeState.banner.prevCastles = undefined;
  }

  function reset(): void {
    runtimeState.banner = createBannerState();
  }

  /** Store an entity snapshot for the banner's before/after comparison.
   *  Called by selection before finalizeAndEnterCannonPhase mutates state. */
  function setPrevEntities(entities: EntityOverlay): void {
    runtimeState.banner.prevEntities = entities;
  }

  return { showBanner, tickBanner, clearSnapshots, reset, setPrevEntities };
}

/** Set up banner state for a phase transition.
 *  Snapshots castles/territory/entities when preservePrevScene is true
 *  so the banner can show a before/after visual comparison. */
function showBannerTransition(deps: ShowBannerDeps): void {
  const {
    banner,
    state,
    battleAnim,
    text,
    subtitle,
    onDone,
    preservePrevScene = false,
    newBattle,
    setModeBanner,
  } = deps;

  // Consume pre-sweep wall snapshot if stashed before finalizeBuildPhase
  const pendingWalls = banner.wallsBeforeSweep;
  banner.wallsBeforeSweep = undefined;

  if (preservePrevScene) {
    // Auto-capture path. The whole block is gated on `banner.prevCastles`
    // being undefined: if the caller has already pre-populated the prev-
    // scene snapshots (host battle→build sets all four from
    // `enterBuildPhase().prev*`; host cannon→battle sets prevCastles +
    // prevEntities before `enterBattlePhase` mutates state; watcher
    // battle→build calls `capturePrevBattleScene`), the subsystem trusts
    // those values and skips its own snapshot. Otherwise the subsystem
    // captures all four from current state. This is what protects the
    // cannon→battle path from picking up the *post*-mutation
    // `state.phase === BATTLE` and capturing the wrong battleAnim values.
    if (banner.prevCastles === undefined) {
      banner.prevCastles = snapshotCastles(state, pendingWalls);
      banner.prevTerritory =
        state.phase === Phase.BATTLE
          ? battleAnim.territory?.map((territory) => new Set(territory))
          : undefined;
      banner.prevWalls =
        state.phase === Phase.BATTLE
          ? battleAnim.walls?.map((wall) => new Set(wall))
          : undefined;
      banner.prevEntities ??= snapshotEntities(state);
    }
  } else {
    banner.prevCastles = undefined;
    banner.prevTerritory = undefined;
    banner.prevWalls = undefined;
    banner.prevEntities = undefined;
  }

  banner.newTerritory = newBattle?.territory;
  banner.newWalls = newBattle?.walls;
  banner.active = true;
  banner.progress = 0;
  banner.text = text;
  banner.subtitle = subtitle;
  banner.callback = onDone;
  setModeBanner();
}
