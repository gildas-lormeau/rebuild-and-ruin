# Roadmap

## 4. Improved UI
- Polish DOM lobby: better styling, animations, room list improvements

## 5. Full Mobile Support
- ~~Smooth zoom transitions (animate between zoom levels)~~ Done
- ~~Home/enemy zoom buttons~~ Done
- ~~Auto-zoom (home on build, best enemy on battle)~~ Done
- ~~Touch input with zoom-aware coordinate conversion~~ Done
- ~~Immediate game start on lobby tap~~ Done
- ~~Quit button on all screens~~ Done
- ~~Pinch-to-zoom override (user always controls zoom level)~~ Done
- ~~Adapted lobby for touch (larger panels)~~ Done
- Minor polish: larger life-lost dialog buttons on touch, hide keyboard hints

## 5b. Mobile Build Phase — Input Parity
Goal: equalize input quality vs desktop, not lower difficulty.
- ~~Virtual d-pad: directional arrows + action + rotate buttons, key repeat, left/right handed option~~ Done
- ~~Cannon snap-to-fit: cursor snaps to nearest valid placement on tap/click~~ Done
- ~~Phantom centering: piece/cannon phantom centered on cursor instead of top-left anchored~~ Done
- ~~Auto-zoom at selection start with "Select your home castle" overlay~~ Done
- ~~Steady camera during castle-build animation~~ Done
- Piece preview zoom: temporary magnified view around cursor during placement
- Undo last piece: remove last placed piece within 1-2s (compensates for fat-finger mis-placement)

## 6. Host Migration
- When host quits, promote another player to host
- Transfer game state to new host
- Seamless for other players — game continues without interruption
- Fallback: if no human available, convert all to AI and let watchers observe

## 7. Advanced Game Mechanics
- 99 players? Larger maps, more zones, tournament bracket
- Deck of cards: draw pieces from a shared deck, strategic choices
- New piece types, power-ups, terrain modifiers
- Ranked matchmaking
- Spectator mode improvements: commentator view, replay system
