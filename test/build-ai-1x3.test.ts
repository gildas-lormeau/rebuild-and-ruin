/**
 * AI build-phase placement tests — 1x3 piece.
 *
 * Run with: deno test --no-check test/build-ai-1x3.test.ts
 */

import { assert } from "jsr:@std/assert";
import {
  parseBoard,
  assertPlacement,
  assertPlacementOneOf,
  assertNotPlacedAt,
} from "./test-helpers.ts";
import { PIECE_1x3 } from "../src/shared/pieces.ts";

Deno.test("AI closes a 3-tile gap in the wall ring", () => {
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
    PIECE_1x3,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
##***###
        
        
        
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
# #    #
###  ###
        
        
        
`,
  );

  assertPlacementOneOf(
    parsed.state,
    parsed,
    PIECE_1x3,
    [
      `
########
#TT    #
#TT    #
#      #
#      #
#      #
# #*** #
###  ###
        
        
        
`,
      `
########
#TT    #
#TT    #
#      #
#      #
#      #
# #    #
###* ###
   *
   *
`,
    ],
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
     #  
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
###  ###
  ***#  
        
        
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

  assertPlacementOneOf(
    parsed.state,
    parsed,
    PIECE_1x3,
    [
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
        
        
`,
      `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
###*####
   *
   *
`,
    ],
  );
});

Deno.test("AI closes a 1-tile gap in the wall ring (obstacle blocks horizontal and vertical)", () => {
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
    PIECE_1x3,
    `
########
#TT    #
#TT    #
#      #
#      #
#  X   #
#      #
###*####
  X*    
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
###X####
        
        
        
`,
  );

  assertPlacementOneOf(
    parsed.state,
    parsed,
    PIECE_1x3,
    [
      `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
###X####
  ***   
        
        
`,
      `
########
#TT    #
#TT    #
#      #
#      #
#      #
# ***  #
###X####
`,
    ],
  );
});

Deno.test("AI closes a 1-tile gap in the wall ring (obstacle 1 tile away blocks vertical)", () => {
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

  assertPlacementOneOf(
    parsed.state,
    parsed,
    PIECE_1x3,
    [
      `
########
#TT    #
#TT    #
#      #
#      #
#      #
# ***  #
### ####
   X    
        
        
`,
      `
########
#TT    #
#TT    #
#      #
#      #
#  *   #
#  *   #
###*####
   X
`,
    ],
  );
});

Deno.test("AI closes a 1-tile gap in the wall ring (obstacle 2 tiles away blocks vertical)", () => {
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
   X    
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#  *   #
###*####
  X*    
   X    
        
`,
  );
});

Deno.test("AI closes a 1-tile gap in the wall ring (2 obstacles blocks outer)", () => {
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
   X    
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#  *   #
###*####
  X*    
   X    
        
`,
  );
});

Deno.test({ name: "AI prefers vertical closure near bank obstacle", ignore: true, fn: () => {
  const parsed = parseBoard(
    `
########
# TT   #
# TT   #
#      #
#      #
# ##   #
###X####
        
        
`,
  );

  // Current behavior picks a horizontal 1x3 bridge here; desired behavior is
  // to avoid that specific horizontal closure pattern.
  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
########
# TT   #
# TT   #
#      #
#      #
# ##***#
###X####
        
        
`,
  );
} });

Deno.test("AI fills gap between wall segments (vertical)", () => {
  const parsed = parseBoard(
    `
       
       
       
   #   
       
       
       
   #   
       
       
       
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
       
       
       
   #   
   *   
   *   
   *   
   #   
       
       
       
`,
  );
});

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
    PIECE_1x3,
    `
       
       
       
   #*  
   #*  
   #*  
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
       
       
       
  *#   
  *#   
  *#   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
       
       
       
   #   
  *#   
  *#   
  *    
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
       
       
       
   #   
   #*  
   #*  
    *  
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
       
       
       
  *    
  *#   
  *#   
   #   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
       
       
       
    *  
   #*  
   #*  
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
    PIECE_1x3,
    `
         
         
   ***   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
         
         
         
   ###   
   ***   
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
         
         
    ***  
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
         
         
  ***    
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
         
         
         
   ###   
    ***  
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x3,
    `
         
         
         
   ###   
  ***    
         
         
`,
  );
});

