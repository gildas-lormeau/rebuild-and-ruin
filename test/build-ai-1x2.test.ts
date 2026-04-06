/**
 * AI build-phase placement tests — 1x2 piece.
 *
 * Run with: deno test --no-check test/build-ai-1x2.test.ts
 */

import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
} from "./test-helpers.ts";
import { PIECE_1x2 } from "../src/shared/pieces.ts";

Deno.test("AI closes a 2-tile gap in the wall ring", () => {
  const parsed = parseBoard(
    `
#######
#TT   #
#TT   #
#     #
#     #
#     #
##  ###
       
       
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x2,
    `
#######
#TT   #
#TT   #
#     #
#     #
#     #
##**###
       
       
`,
  );
});

Deno.test("AI closes a 1-tile gap in the wall ring (obstacle blocks outer)", () => {
  const parsed = parseBoard(
    `
#######
#TT   #
#TT   #
#     #
#     #
#     #
## ####
  X    
       
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x2,
    `
#######
#TT   #
#TT   #
#     #
#     #
# *   #
##*####
  X    
       
`,
  );
});

Deno.test("AI closes a 1-tile gap in the wall ring (walls blocks inner)", () => {
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

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x2,
    `
########
# TT   #
# TT   #
#      #
#   *  #
# ##*  #
###X####
        
        
`,
  );
});

Deno.test("AI closes a 1-tile gap in the wall ring (no obstacle)", () => {
  const parsed = parseBoard(
    `
#######
#TT   #
#TT   #
#     #
#     #
#     #
## ####
       
       
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x2,
    `
#######
#TT   #
#TT   #
#     #
#     #
#     #
##*####
  *    
       
`,
  );
});

Deno.test({ name: "AI fills gap between wall segments", ignore: true, fn: () => {
  const parsed = parseBoard(
    `
        
        
  #  #  
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x2,
    `
        
        
  #**#  
        
        
`,
  );
} });

Deno.test("AI does not create fat walls (vertical)", () => {
  const parsed = parseBoard(
    `
     
     
  #  
  #  
     
     
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x2,
    `
     
     
  #* 
  #* 
     
     
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x2,
    `
     
     
 *#  
 *#  
     
     
`,
  );
});

Deno.test("AI does not create fat walls (horizontal)", () => {
  const parsed = parseBoard(
    `
      
      
  ##  
      
      
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x2,
    `
      
  **  
  ##  
      
      
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x2,
    `
      
      
  ##  
  **  
      
`,
  );
});

