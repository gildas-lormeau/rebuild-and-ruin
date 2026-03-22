/**
 * AI build-phase placement tests — S piece.
 *
 * Run with: bun test/build-ai-S.test.ts
 */

import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
  knownFailureTest,
  test,
  runTests,
} from "./test-helpers.ts";
import { PIECE_S } from "../src/pieces.ts";

test("AI closes a 2-tile gap in the wall ring", () => {
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

test("AI closes a 2-tile gap in the wall ring (inner obstacle)", () => {
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

test("AI closes a 4-tile corner gap", () => {
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

test("AI closes a 3-tile corner gap", () => {
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


test("AI closes a 2-tile corner gap", () => {
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


knownFailureTest("AI fills gap between wall segments", () => {
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

test("AI does not create fat walls (horizontal)", () => {
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

test("AI does not create 1 square enclosure", () => {
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

runTests("Build AI — S piece");
