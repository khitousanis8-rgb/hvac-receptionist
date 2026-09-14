import { runAllTests } from "./text-normalization.test.ts";

const { passed, failed } = runAllTests();
console.log(`Test Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All 20 spoken-text normalization tests passed!");
}

