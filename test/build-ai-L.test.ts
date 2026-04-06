/**
 * AI build-phase placement tests — L piece.
 *
 * Run with: deno test --no-check test/build-ai-L.test.ts
 */

import { assert } from "jsr:@std/assert";
import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
} from "./test-helpers.ts";
import { PIECE_L } from "../src/shared/pieces.ts";

Deno.test("AI closes a 3-tile gap in the wall ring (obstacle right of gap)", () => {
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

Deno.test("AI closes a 3-tile gap in the wall ring (obstacle left of gap)", () => {
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

Deno.test("AI closes a 2-tile gap in the wall ring (outer)", () => {
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

Deno.test("AI closes a 2-tile gap in the wall ring (inner)", () => {
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

Deno.test("AI closes a 1-tile gap in the wall ring", () => {
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

Deno.test("AI closes a 1-tile gap in the wall ring (obstacle in the hole)", () => {
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

Deno.test("AI closes a 2-tile gap in the wall ring (obstacle 1 row below blocks vertical)", () => {
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

Deno.test("AI closes a 1-tile gap in the wall ring (obstacle 2 rows below gap)", () => {
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

Deno.test("AI closes a 1-tile gap in the wall ring (2 obstacles below gap block outer)", () => {
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

Deno.test("AI closes a 1-tile gap in the wall ring (obstacle directly below blocks outer)", () => {
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

Deno.test("AI closes a 2-tile corner gap", () => {
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

Deno.test("AI closes a 2-tile corner gap (obstacle next to the gap)", () => {
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

Deno.test({ name: "AI fills gap between wall segments", ignore: true, fn: () => {
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
} });

Deno.test("AI does not create fat walls (vertical)", () => {
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

Deno.test("AI does not create fat walls (horizontal)", () => {
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

Deno.test("AI does not create 1 square enclosure (vertical)", () => {
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

Deno.test("AI does not create 1 square enclosure (horizontal)", () => {
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

