/** Input action names returned by matchKey / used in key dispatch.
 *  ROTATE is context-dependent: rotates piece in WALL_BUILD,
 *  cycles cannon mode in CANNON_PLACE, and sprints crosshair in BATTLE. */

export enum Action {
  UP = "up",
  DOWN = "down",
  LEFT = "left",
  RIGHT = "right",
  CONFIRM = "confirm",
  /** Rotate piece (build), cycle cannon mode (cannon), sprint crosshair (battle). */
  ROTATE = "rotate",
}
