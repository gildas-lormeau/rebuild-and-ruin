/** Abstracted input vocabulary the controller contract speaks in: the
 *  gameplay command verbs (`Action`) and their keyboard keymap
 *  (`KeyBindings`), decoupled from raw keycodes. In core because the
 *  `PlayerController` / `InputReceiver` interfaces are defined over them;
 *  the binding DATA (PLAYER_KEY_BINDINGS) stays in `ui/player-config.ts`.
 *  ROTATE is context-dependent: rotates piece in WALL_BUILD, cycles cannon
 *  mode in CANNON_PLACE, sprints crosshair in BATTLE. */

export enum Action {
  UP = "up",
  DOWN = "down",
  LEFT = "left",
  RIGHT = "right",
  CONFIRM = "confirm",
  /** Rotate piece (build), cycle cannon mode (cannon), sprint crosshair (battle). */
  ROTATE = "rotate",
}

export interface KeyBindings {
  up: string;
  down: string;
  left: string;
  right: string;
  confirm: string; // place / fire / select
  rotate: string; // rotate piece / cycle cannon mode / accelerate crosshair
}

export function isMovementAction(action: Action): boolean {
  return (
    action === Action.UP ||
    action === Action.DOWN ||
    action === Action.LEFT ||
    action === Action.RIGHT
  );
}
