# Pact System — Design Spec

**Status: DRAFT — design only, not scheduled, nothing implemented.**
Feature id: `pacts` (fifth modern-mode capability, alongside modifiers / upgrades / combos / catapults).
Origin: team-up bonus brainstorm, 2026-07-16. This spec pins the rules; tuning values are marked TBD.

A round-scoped diplomacy layer for modern mode: players publicly signal a pact
intent during Cannon Place, then secretly commit one pact card before battle.
Matching commitments activate a shared bonus for the coming battle. Because
every game action is public and attributed (`scoringPlayerId`), pact compliance
is verified by the simulation itself — no trust infrastructure, and betrayal is
visible the moment it happens.

Design goals: add intent/bluffing/reputation texture to a 3-player FFA, create
catch-up pressure against the score leader, and reuse existing effect pathways
(most cards re-scope an implemented upgrade to a pair).

---

## Design-invariant compliance

- **Grunts stay neutral.** No card commands grunts. Conscription Compact (extended pool) only aims spawn *direction*, which the base rules already allow.
- **Zones stay sealed.** Every effect is a buff, a scoring re-price, or a timer/lockout change. No card spatially touches another player's zone; cross-zone interaction remains cannonballs only.
- **Territory scoring stays linear.** Land Grant (extended pool) is a `territoryScoreMult`-style multiplier, same shape as Territorial Ambition (1.5×).
- **Max 3 players.** The whole system is built around the 3-player matching space and gates off below 3 alive.
- **No new game mode.** `pacts` is a `FeatureId` in `FEATURE_POOL`, active in modern via `setGameMode`, guarded by `hasFeature(state, "pacts")`.

---

## Player-facing rules

### Gating

Pacts run in a round when ALL hold (mirrors the modifier/upgrade gates):

- Modern mode (`hasFeature(state, "pacts")`).
- Round ≥ 3 (same as modifiers and upgrades — standings exist, players know the map).
- Exactly 3 players alive. Two-player rounds have no third party to team against; the feature silently skips.
- Not the final round and not a sudden-death overtime round (same reasoning as upgrade offers: no kingmaking lever when the match can end on this round's scores).

### Round flow

```
CANNON_PLACE            → [PACT_COMMIT]     → [MODIFIER_REVEAL] → BATTLE           → ...
  hand dealt at entry       hidden pick 6s      (unchanged)        compliance
  proposals (public,        reveal banner 2s                       tracked
  optional)                 pacts resolved                         payout at finalizeRound
```

1. **Deal** — at Cannon Place entry, each player is dealt **2 pact cards** from `PACT_POOL` (weighted synced-RNG draw, same rarity vocabulary as the other pools). Hands are **public**. Two **standing options** are always available to everyone in addition to the dealt cards: **Abstain** and **Defiance**.
2. **Propose (step 1, optional)** — during Cannon Place, a player may publicly flag one card from their options as their declared intent (shown as a chip by their banner). Non-binding cheap talk. Declaring nothing is legal and common. This is deliberately *during* cannon placement so the third player can react with cannon positioning.
3. **Commit (step 2)** — `PACT_COMMIT`, a new conditional self-driving phase (like `UPGRADE_PICK`): each player secretly picks exactly one option. Shared **~6s** timer (TBD); timeout auto-commits **Abstain** (never a random card — an unchosen pact must not bind anyone). UI reuses the upgrade-pick card dialog; the committed pick is hidden from other players and from AI view slices until reveal.
4. **Reveal** — all picks flip face-up simultaneously on a **2s banner** (reuses the modifier-reveal banner machinery). Matches activate; mismatches fizzle visibly — a fizzle against a step-1 proposal is public information about who bluffed.
5. **Battle** — active pacts apply their effects; compliance is tracked from impact attribution.
6. **Payout** — pact bonuses are awarded in `finalizeRound` with the other end-of-round scoring, and shown on the score overlay.

### Matching rules

- **Mirror match** — identical directed card with the identical target: `War Pact vs Gold` + `War Pact vs Gold` → pact between the two committers.
- **Reciprocal match** — complementary directed pair: `Non-Aggression w/ Blue` (from Red) + `Non-Aggression w/ Red` (from Blue); `Protector of Blue` + `Accept Protection`.
- **Conditional self-match** — Defiance activates iff both opponents' revealed picks target you; Abstain never activates anything.
- Anything unmatched **fizzles** — no effect, no penalty.
- **One pact per player is structural**, not a rule: each player commits exactly one card, a card can form at most one match, and no card can target its own holder — so a 3-way identical pick is impossible for directed cards, and nobody needs a tiebreak. (All three committing the same undirected option, e.g. three Defiances, resolves to three fizzles via the activation conditions.)

### Compliance and betrayal

- **Violation** = destroying a matched partner's **wall tile or cannon** during the pact battle (attributed via `scoringPlayerId`). Killing grunts in the partner's zone is *not* a violation (grunts are neutral hazards; culling them helps the partner).
- **Intent doesn't matter.** Ricochet bounces, mortar splash, and Dust Storm jitter that destroy partner property all count. Entering a pact makes your shots your responsibility — aim away from your partner. (Deterministic, zero ambiguity, no "accident" adjudication.)
- **Penalty on violation:** the betrayer's pact effects deactivate immediately, the betrayer forfeits their pact payout, and their further destruction against the victim scores **0 points** for the rest of the battle (TBD: whether the first violating hit also scores 0). The victim keeps their pact effects and payout eligibility.
- Betrayal is announced (banner/kill-feed style line) — the drama is the point.

---

## Starter card set (v1 ships exactly these)

| Card | Kind | Match | Effect while active (one battle) | Reuses |
|---|---|---|---|---|
| **War Pact vs T** | dealt, directed offense | mirror (same T) | Both partners' destruction scoring against T doubled (walls +4, grunts/cannons +32 when in T's zone). Pays only via landed hits — anti-idle is inherent. | impact attribution + combo scoring hooks |
| **Non-Aggression w/ X** | dealt, directed defense | reciprocal | No buff. The deal is the deal: mutual no-damage, compliance-checked, violation penalized. Cheapest card in the set. | compliance checker only |
| **Engineers' Exchange w/ X** | dealt, directed tempo | reciprocal | Next Wall Build: both partners get a Master Builder-style +3s (TBD) exclusive head start; the third player is locked out. | `masterBuilderLockout` — multi-owner semantics already exist |
| **Protector of X / Accept Protection** | dealt, asymmetric pair | reciprocal (different cards) | Protector: kills landed inside X's zone score double; +150 pts (TBD) if X ends the round with all enclosed towers alive. Client: safety + free debris clear at next build start. | attribution + `reclamation` pathway |
| **Defiance** | standing, conditional | self (both opponents targeted me) | Reinforced Walls for the battle + destruction against either opponent +50% (TBD). The anti-gang-up counter that keeps coalitions non-dominant and makes step-1 proposals strategically loaded. | `reinforced_walls` flag + scoring mult |
| **Abstain** | standing | never | Nothing. Timeout default. | — |

## Extended pool (post-v1 candidates, from the 2026-07-16 catalog)

Synchronized Barrage (pair Rapid Fire scoped to shots into T's zone) · Scorched
Earth Compact (wall kills vs T spawn pits) · Conscription Compact (partners'
grunt kills respawn in T's zone) · Balloon Syndicate (pair balloon hits vs T
count double) · Demolition Contract (announced objective, all-or-nothing
payout) · Mutual Defense Works (pair Reinforced Walls) · Air Defense League
(+1 balloon hit threshold on both partners) · Border Militia (Pikemen-style
first-2-grunts auto-kill in both zones) · Land Grant (+25% territory if both
partners also hit the third player) · War Chest (pooled destruction points,
even split) · Trade Agreement (score per partner's surviving houses — needs
tight cap) · Opportunist (standing: small self-buff iff you're pactless while
another pact activated) · Tribute / Accept-Tribute (score transfer for bound
peace — the one card where the leader belongs; hardest kingmaking cap, decide
before drafting it into the pool).

## Rejected designs (do not revisit without new arguments)

- **False Flag** (match as a partner, get rewarded for betraying): breaks the system's one fixed point. Step 1 is already the bluff; if the *match* can also be a trap, no revealed pact is trustworthy and rational players stop pacting. The reveal must be where trust becomes mechanical; post-reveal betrayal stays possible but only ever as a penalized choice.
- **Unconditioned peace dividends** (score for merely not fighting): turtle equilibrium. Defensive cards pay in utility, not points; economic cards carry an engagement condition or a hard cap.
- **3-way pacts**: with 3 players a universal pact means nobody fights; the matching space is deliberately pairwise.

---

## Edge cases

- **Timeout** → Abstain, never a random card.
- **All three pick the same card**: impossible for directed cards (no self-targeting, so at most the two non-targets can hold the identical card); undirected options all-fizzle via their activation conditions. No special-case code.
- **Elimination during the pact round** (life lost at the closing build): pacts are already resolved and paid out in that round's `finalizeRound` before elimination routing; next round the 3-alive gate fails and the feature skips. No pact state survives the round.
- **Stacking with upgrades**: pact effects stack with owned upgrades (they're orthogonal systems; e.g. Rapid Fire + War Pact is legal). Duplicated *flags* (Defiance's Reinforced Walls while owning Reinforced Walls) simply don't stack — same 2-hit walls.
- **Ceasefire upgrade fires the same round**: battle is skipped → no impacts → battle-scoped pacts fizzle at payout (no landed hits) and Non-Aggression trivially holds. Acceptable; no interaction code.
- **Leader participation** — OPEN. v1 allows the leader in any pact (final-round + overtime skip and payout caps are the kingmaking guards). If play shows leader-peace freezing matches, the cheap fix is the dealer: restrict partner-directed cards from the leader's hand. Decide from real games, not upfront.

---

## Architecture mapping

Follows `docs/adding-modifiers-and-upgrades.md` conventions throughout.

- **Registry**: `PactId` union + `PACT_POOL` (rarity-weighted, `implemented` flags, `PoolComplete` check) + `PACT_CONSUMERS` map, in a new `src/shared/core/pact-defs.ts` (L0, same shape as `upgrade-defs.ts`). Effects introduce a **`scope` axis** (`pair | target`) extending the existing `global: boolean` idea. Registry-driven impls (`PACT_IMPLS`, like `MODIFIER_IMPLS`) so phase code never grows per-card branches.
- **Feature gate**: add `"pacts"` to `FeatureId` + `FEATURE_POOL` + `FEATURE_CONSUMERS`; modern's feature set gains it via `setGameMode`.
- **Phase**: `PACT_COMMIT`, conditional and self-driving like `UPGRADE_PICK` (re-derived from state every frame, no armed callback → host-promotion safe). Entered from the cannon-place-done transition **before** `prepareBattleState`'s modifier roll, via an `enterPactCommitPhase` helper in `phase-entry.ts`. Reveal is a banner beat at the end of the phase (modifier-reveal machinery), after which resolved pacts are plain public state.
- **State** (`ModernState`): `pactHands` (dealt, public), `pactProposals` (public), `pactCommits` (hidden-until-reveal), `activePacts` (post-reveal, incl. violation flags), payout accumulators. Reset in `prepareNextRound` with the other one-round effects.
- **Hidden info**: commits are display-gated only (clients are trusted; server is a relay — precedent: `SupplyShip.bonus` is hidden until sunk). Hard rule: unrevealed commits must be excluded from AI view slices (`BattleViewState` etc.) — "AI uses human-visible info only". Commit-reveal hashing is a known upgrade if the trust model ever changes; explicitly out of scope.
- **Wire**: two input messages (`PACT_PROPOSE`, `PACT_COMMIT`) — uncomputable human input, everything else mirror-simulated. Deal uses synced RNG at cannon entry (no wire traffic). Resolved pacts ride the BATTLE_START checkpoint; mid-window FULL_STATE snapshots must carry hands/proposals/commits (same class as `FullStateMessage.roundEnd` routing — the `checkpoint-fields` lint will demand this).
- **AI**: stance policy in `ai/` (public info only: standings, prior fizzles/betrayals this match; per-player variation injected at the shared mechanism, synced-RNG-drawn). Battle compliance = partner's walls/cannons excluded from target selection in `ai-strategy-battle.ts` while pacted. Proposal step: AI declares its true intent with probability p (TBD) — honest-by-default reads better than random bluffing.
- **Input**: the commit dialog reuses upgrade-pick controls (Left/Right/Confirm, click/tap). The **only genuinely new input surface** is the optional step-1 proposal during Cannon Place (cycle-stance key + a tap chip on touch) — the known-expensive part; keep it one control.
- **mcp-play**: the play server drives one slot through the real controller/intent path, so pacts need two new tools following the `pick_upgrade` pattern — `propose_pact` (step 1, optional) and `commit_pact` (step 2) — plus PACT_COMMIT-beat handling in `observe`'s EXPECTED line and hand/proposal/reveal state in the ASCII render and JSON observation. The hidden-info rule applies to the observation itself: opponents' unrevealed commits are excluded (the agent is a player — same visibility as AI view slices). Fairness invariant: no game-time charge — proposals and commits are one-per-round self-limiting decisions, same carve-out as slot-capped cannon placement. Post-reveal pact state joins the `observationDigest` sidecar so `deno task replay --diff` catches pact-affecting regressions.
- **Testing**: `testHooks.forcePactHand` / `forcePactCommit` (short-circuit the RNG draws, like `forceModifier` / `forceUpgrade`). Scenario tests via `createScenario` + bus events (`PACT_REVEALED`, `PACT_VIOLATED`, payout in ROUND_END data) — one test per rule above, no extra guardrails. Classic-mode determinism fixtures unaffected; modern fixtures need re-record via the standard `check-determinism` → `record --all` chain once RNG draws are added.

## Tuning TBDs (probe with ai-compare / real games before shipping)

| Knob | Placeholder | Note |
|---|---|---|
| Commit window | 6s | must stay shorter than UPGRADE_PICK's 15s — 4 fixed options, not 3 unseen cards |
| War Pact multiplier | 2× destruction vs T | self-limiting (needs landed hits) |
| Engineers' Exchange head start | +3s | vs Master Builder's 5s — pair-wide, so cheaper per player |
| Protector completion bonus | 150 | below bonus-square floor (100–1000 scale) |
| Defiance package | reinforced walls + 1.5× vs both | must beat being ganged, not beat not-being-ganged |
| Betrayal penalty | effects off + payout forfeit + 0-score vs victim | first-hit scoring TBD |
| Payout cap (any single pact) | ≤ 300/player/round | keeps pacts under castle-bonus tier — narrows leads, never flips a match by itself |
| AI honest-proposal probability | 0.7 | pure-random proposals make step 1 noise |
