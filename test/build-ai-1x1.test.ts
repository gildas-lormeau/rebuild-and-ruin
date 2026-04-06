/**
 * AI build-phase placement tests — 1x1 piece.
 *
 * Run with: deno run test/build-ai-1x1.test.ts
 */

import {
  parseBoard,
  assertPlacement,
  assertNotPlacedAt,
  knownFailureTest,
  test,
  runTests,
} from "./test-helpers.ts";
import { PIECE_1x1 } from "../src/shared/pieces.ts";

test("AI closes a 1-tile gap in the wall ring", () => {
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

test("AI closes a 1-tile corner gap", () => {
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

knownFailureTest("AI fills gap between wall segments (horizontal)", () => {
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
});

knownFailureTest("AI fills gap between wall segments (vertical)", () => {
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
});

test("AI does not create fat walls", () => {
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

await runTests("Build AI — 1x1 piece");
