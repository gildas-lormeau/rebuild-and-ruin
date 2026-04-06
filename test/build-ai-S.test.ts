/**
 * AI build-phase placement tests — S piece.
 *
 * Run with: deno test --no-check test/build-ai-S.test.ts
 */

import { assert } from "jsr:@std/assert";
import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
} from "./test-helpers.ts";
import { PIECE_S } from "../src/shared/pieces.ts";

Deno.test("AI closes a 2-tile gap in the wall ring", () => {
  const parsed = parseBoard(
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#  XX  #
###  ###
        
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_S,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#  XX  #
###**###
  **
        
        
`,
  );
});

Deno.test("AI closes a 2-tile gap in the wall ring (inner obstacle)", () => {
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
        
        
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_S,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#  *X  #
###**###
    *   
        
        
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
        
   X    
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_S,
    `
########
#TT    #
#TT    #
#      #
#      #
#      #
#      #
###*####
   **   
   X*   
        
`,
  );
});

Deno.test("AI closes a 4-tile corner gap", () => {
  const parsed = parseBoard(
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
          #
          #
     ######
           
           
           
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_S,
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
   *      #
   **     #
    *######
           
           
           
`,
  );
});

Deno.test("AI closes a 3-tile corner gap", () => {
  const parsed = parseBoard(
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
   #      #
          #
     ######
           
           
           
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_S,
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
   #      #
   *      #
   **######
    *      
           
           
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
   #      #
     ######
           
           
           
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_S,
    `
   ########
   #TT    #
   #TT    #
   #      #
   #      #
   #      #
   #      #
   **######
  **       
           
           
`,
  );
});


Deno.test({ name: "AI fills gap between wall segments", ignore: true, fn: () => {
  const parsed = parseBoard(
    `
        
        
  #  #  
   X    
        
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_S,
    `
        
   *    
  #**#  
   X*   
        
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
    PIECE_S,
    `
       
       
       
   #*  
   #** 
   # * 
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_S,
    `
       
       
       
 * #   
 **#   
  *#   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_S,
    `
       
       
 *     
 **#   
  *#   
   #   
       
       
       
`,
  );

   assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_S,
    `
       
       
       
   #   
   #*  
   #** 
     * 
       
       
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
    PIECE_S,
    `
         
    **   
   **    
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_S,
    `
         
     **  
    **   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_S,
    `
         
         
         
   ###   
   **    
  **     
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_S,
    `
         
         
         
   ###   
    **   
   **    
         
`,
  );
});

Deno.test("AI does not create 1 square enclosure", () => {
  let parsed = parseBoard(
    `
         
   #     
   #     
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_S,
    `
    *    
   #**   
   # *   
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
    PIECE_S,
    `
         
         
         
   ###   
   # **  
    **   
         
`,
  );
});

