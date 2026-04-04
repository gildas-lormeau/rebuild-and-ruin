/**
 * AI build-phase placement tests — L piece.
 *
 * Run with: bun test/build-ai-L.test.ts
 */

import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
  knownFailureTest,
  test,
  runTests,
} from "./test-helpers.ts";
import { PIECE_L } from "../src/shared/pieces.ts";

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
  X     
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_L,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#   *  #
##***###
  X     
        
        
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
    PIECE_L,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
##***###
  * X   
        
        
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
        
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_L,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
### *###
  ***   
        
        
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
#      #
###  ###
  X     
    X   
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_L,
    `
########
#TT    #
#TT    #
#      #
#      #
#  *   #
#  *   #
###**###
  X     
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
    PIECE_L,
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
  *
        
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
###X ###
        
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_L,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
###X*###
  ***   
        
        
`,
  );
});

test("AI closes a 2-tile gap in the wall ring (obstacle 1 row below blocks vertical)", () => {
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
    PIECE_L,
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
    *   
        
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
    PIECE_L,
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
  *X    
        
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
# X X  #
# X    #
### ####
  X     
    X   
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_L,
    `
########
#TT    #
#TT    #
#      #
#      #
# X X  #
# X*   #
###*####
  X**   
    X   
        
`,
  );
});

test("AI closes a 1-tile gap in the wall ring (obstacle directly below blocks outer)", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#  X   #
#      #
### ####
   X    
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_L,
    `
########
#TT    #
#TT    #
#      #
#      #
#  X*  #
# ***  #
### ####
   X    
        
        
`,
  );
});

test("AI closes a 2-tile corner gap", () => {
  const parsed = parseBoard(
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
   #      #
          #
    #######
           
           
           
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_L,
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
  *#      #
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

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_L,
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
  X#      #
  **      #
   *#######
   *       
           
           
`,
  );
});

knownFailureTest("AI fills gap between wall segments", () => {
  const parsed = parseBoard(
    `
           
           
   #   #   
    X      
           
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_L,
    `
           
      *    
   #***#   
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
    PIECE_L,
    `
       
       
       
   #*  
   #*  
   #** 
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
       
       
       
 **#   
  *#   
  *#   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
       
       
       
   #   
  *#   
  *#   
  **   
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
       
       
       
   #   
   #*  
   #*  
    ** 
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
       
       
 **    
  *#   
  *#   
   #   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
       
       
    *  
   #*  
   #** 
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
    PIECE_L,
    `
         
         
     *   
   ***   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
         
         
         
   ###   
   ***   
   *     
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
         
     *   
   ***   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
         
    *    
  ***    
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
         
         
         
   ###*  
    ***  
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
         
         
         
   ###   
  ***    
  *      
         
`,
  );
});

test("AI does not create 1 square enclosure (vertical)", () => {
  let parsed = parseBoard(
    `
       
       
       
  ##   
   #   
   #   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
       
       
       
 *##   
 * #   
 **#   
       
       
       
`,
  );

  parsed = parseBoard(
    `
       
       
       
   #   
   #   
   ##  
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
       
       
       
   #** 
   # * 
   ##* 
       
       
       
`,
  );
});

test("AI does not create 1 square enclosure (horizontal)", () => {
  let parsed = parseBoard(
    `
         
         
     #   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
         
   ***   
   * #   
   ###   
         
         
         
`,
  );

  parsed = parseBoard(
    `
         
         
         
   ###   
   #     
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_L,
    `
         
         
         
   ###   
   # *   
   ***   
         
`,
  );
});

await runTests("Build AI — L piece");
