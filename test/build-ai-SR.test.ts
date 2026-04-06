/**
 * AI build-phase placement tests — SR piece.
 *
 * Run with: deno run test/build-ai-SR.test.ts
 */

import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
  knownFailureTest,
  test,
  runTests,
} from "./test-helpers.ts";
import { PIECE_SR } from "../src/shared/pieces.ts";

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
    PIECE_SR,
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
#  X   #   
###  ###   
           
           
           
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_SR,
    `
########   
#TT    #   
#TT    #   
#      #   
#      #   
#      #   
#  X*  #   
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
#### ###   
           
    X      
           
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_SR,
    `
########   
#TT    #   
#TT    #   
#      #   
#      #   
#      #   
#      #   
####*###   
   **      
   *X      
           
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
    PIECE_SR,
    `
########   
#TT    #   
#TT    #   
#      #   
#      #   
#      *   
#     **   
######*    
           
           
           
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
    PIECE_SR,
    `
########   
#TT    #   
#TT    #   
#      #   
#      #   
#      #   
#      *   
######**   
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
    PIECE_SR,
    `
########   
#TT    #   
#TT    #   
#      #   
#      #   
#      #   
#      #   
######**   
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
    PIECE_SR,
    `
       
    *  
  #**# 
   *X  
       
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
    PIECE_SR,
    `
       
       
       
   # * 
   #** 
   #*  
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_SR,
    `
       
       
       
  *#   
 **#   
 * #   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_SR,
    `
       
       
  *    
 **#   
 * #   
   #   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_SR,
    `
       
       
       
   #   
   # * 
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
    PIECE_SR,
    `
         
   **    
    **   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_SR,
    `
         
  **     
   **    
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_SR,
    `
         
         
         
   ###   
   **    
    **   
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_SR,
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
    PIECE_SR,
    `
    *    
   **#   
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
    PIECE_SR,
    `
         
         
         
   ###   
  ** #   
   **    
         
`,
  );
});

await runTests("Build AI — SR piece");
