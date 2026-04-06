/**
 * AI build-phase placement tests — + piece.
 *
 * Run with: deno run test/build-ai-PLUS.test.ts
 */

import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
  knownFailureTest,
  test,
  runTests,
} from "./test-helpers.ts";
import { PIECE_PLUS } from "../src/shared/pieces.ts";

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
    PIECE_PLUS,
    `
         
    *    
  #***#  
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
    PIECE_PLUS,
    `
       
    *  
   *** 
   #*  
   #   
   #   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
       
       
       
   #   
   #   
   #*  
   *** 
    *  
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
       
  *    
 ***   
  *#   
   #   
   #   
       
       
       
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
       
       
       
   #   
   #   
  *#   
 ***   
  *    
       
`,
  );
});

test("AI does not create fat walls (horizontal)", () => {
  const parsed = parseBoard(
    `
         
         
         
   # #   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
         
    *    
   ***   
   #*#   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
         
  *      
 ***     
  *# #   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
         
         
         
   #*#   
   ***   
    *    
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
         
         
         
  *# #   
 ***     
  *      
         
`,
  );
});

test("AI does not create 1 square enclosure", () => {
  let parsed = parseBoard(
    `
         
         
         
   ###   
   #     
   #     
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
         
         
         
   ###   
   # *   
   #***  
     *   
         
         
         
`,
  );

  parsed = parseBoard(
    `
         
         
         
   ###   
     #   
     #   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
         
         
         
   ###   
   * #   
  ***#   
   *     
         
         
`,
  );

  parsed = parseBoard(
    `
         
         
         
   #     
   #     
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
         
         
     *   
   #***  
   # *   
   ###   
         
         
         
`,
  );

  parsed = parseBoard(
    `
         
         
         
     #   
     #   
   ###   
         
         
         
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_PLUS,
    `
         
         
   *     
  ***#   
   * #   
   ###   
         
         
         
`,
  );
});

await runTests("Build AI — + piece");
