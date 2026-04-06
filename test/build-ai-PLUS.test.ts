/**
 * AI build-phase placement tests — + piece.
 *
 * Run with: deno test --no-check test/build-ai-PLUS.test.ts
 */

import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
} from "./test-helpers.ts";
import { PIECE_PLUS } from "../src/shared/pieces.ts";

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
    PIECE_PLUS,
    `
         
    *    
  #***#  
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

Deno.test("AI does not create fat walls (horizontal)", () => {
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

Deno.test("AI does not create 1 square enclosure", () => {
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

