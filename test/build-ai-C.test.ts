/**
 * AI build-phase placement tests — C piece.
 *
 * Run with: bun test/build-ai-C.test.ts
 */

import {
  parseBoard,
  assertPlacement,
  assertPlacementOneOf,
  assertNotPlacedAt,
  knownFailureTest,
  test,
  runTests,
} from "./test-helpers.ts";
import { PIECE_C } from "../src/shared/pieces.ts";

test("AI closes a 3-tile gap in the wall ring (obstacle right of gap)", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
##   ###
        
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
##* *###
  ***   
        
        
`,
  );
});

test("AI closes a 3-tile gap in the wall ring (obstacle left of gap)", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
##   ###
  X     
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
# * *  #
##***###
  X     
        
        
`,
  );
});

test("AI closes a 2-tile gap in the wall ring (outer)", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
###  ###
   X    
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
###**###
   X*   
   **   
        
`,
  );
});

test("AI closes a 2-tile gap in the wall ring (inner)", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#   X  #
###  ###
        
    X   
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
########
#TT    #
#TT    #
#      #
#      #
#  **  #
#  *X  #
###**###
        
    X   
        
`,
  );
});

test("AI closes a 1-tile gap in the wall ring", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
### ####
        
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
### ####
  * *   
  ***   
        
`,
  );
});

test("AI closes a 1-tile gap in the wall ring (obstacle in the hole)", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
## X ###
        
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
##*X*###
  ***   
        
        
`,
  );
});

test("AI closes a 1-tile gap in the wall ring (obstacle 2 rows below gap)", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
### ####
        
   X    
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
### ####
  ***   
  *X*   
        
`,
  );
});

test("AI closes a 1-tile gap in the wall ring (2 obstacles below gap block outer)", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#   X  #
#      #
### ####
  X     
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
########
#TT    #
#TT    #
#      #
#      #
#   X  #
#  **  #
###*####
  X**   
        
        
`,
  );
});

test("AI closes a 3-tile corner gap", () => {
  const parsed = parseBoard(
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
          #
          #
    #######
           
           
           
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
  **      #
  *       #
  **#######
           
           
           
`,
  );
});

test("AI closes a 2-tile corner gap (obstacle next to the gap)", () => {
  const parsed = parseBoard(
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
  X#      #
          #
    #######
           
           
           
`,
  );

  assertPlacementOneOf(
    parsed.state,
    parsed,
    PIECE_C,
    [
      `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
  X#      #
  **      #
   *#######
  **       
           
           
`,
      `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
  X#      #
 * *      #
 ***#######
`,
    ],
  );
});

knownFailureTest("AI fills gap between wall segments", () => {
  const parsed = parseBoard(
    `
           
     X     
  ##   ##  
    X      
           
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_C,
    `
           
    *X*    
  ##***##  
    X      
           
`,
  );
});

test("AI does not create fat walls (vertical)", () => {
  const parsed = parseBoard(
    `
       
       
       
   #   
   #   
   #   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
       
       
       
   #** 
   #*  
   #** 
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
       
       
       
 **#   
  *#   
 **#   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
       
       
       
   #   
   #   
  *#*  
  ***  
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
       
       
  ***  
  *#*  
   #   
   #   
       
       
       
`,
  );
});

test("AI does not create fat walls (horizontal)", () => {
  const parsed = parseBoard(
    `
         
         
         
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
         
         
   * *   
   ***   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
         
         
         
   ###   
   ***   
   * *   
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
         
   * *   
   ***   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
         
  * *    
  ***    
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
         
         
         
   ###   
  ***    
  * *    
         
`,
  );
});

test("AI does not create 1 square enclosure (vertical)", () => {
  const parsed = parseBoard(
    `
       
       
       
   #   
   #   
   #   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
       
       
       
 **#   
 * #   
 **#   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
       
       
       
   #** 
   # * 
   #** 
       
       
       
`,
  );
});

test("AI does not create 1 square enclosure (horizontal)", () => {
  const parsed = parseBoard(
    `
         
         
         
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
         
   ***   
   * *   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_C,
    `
         
         
         
   ###   
   * *   
   ***    
         
`,
  );
});

await runTests("Build AI — C piece");
