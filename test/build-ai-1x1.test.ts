/**
 * AI build-phase placement tests — 1x1 piece.
 *
 * Run with: deno test --no-check test/build-ai-1x1.test.ts
 */

import { assert } from "jsr:@std/assert";
import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
} from "./test-helpers.ts";
import { PIECE_1x1 } from "../src/shared/pieces.ts";

Deno.test("AI closes a 1-tile gap in the wall ring", () => {
  const parsed = parseBoard(
    `
######
#TT  #
#TT  #
#    #
#    #
## ###
      
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x1,
    `
######
#TT  #
#TT  #
#    #
#    #
##*###
      
`,
  );
});

Deno.test("AI closes a 1-tile corner gap", () => {
  const parsed = parseBoard(
    `
######
#TT  #
#TT  #
#    #
#    #
##### 
      
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x1,
    `
######
#TT  #
#TT  #
#    #
#    #
#####*
      
`,
  );
});

Deno.test({ name: "AI fills gap between wall segments (horizontal)", ignore: true, fn: () => {
  const parsed = parseBoard(
    `
     
 # # 
     
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x1,
    `
     
 #*# 
     
`,
  );
} });

Deno.test({ name: "AI fills gap between wall segments (vertical)", ignore: true, fn: () => {
  const parsed = parseBoard(
    `
   
 # 
   
 # 
   
`,
  );

  assertPlacement(
    parsed.state,
    parsed,
    PIECE_1x1,
    `
   
 # 
 * 
 # 
   
`,
  );
} });

Deno.test("AI does not create fat walls", () => {
  const parsed = parseBoard(
    `
    
 ## 
 #  
    
`,
  );

  assertNotPlacedAt(
    parsed.state,
    parsed,
    PIECE_1x1,
    `
    
 ## 
 #* 
    
`,
  );
});

