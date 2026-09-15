import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAllTests } from "./text-normalization.test.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log("=================================================================");
console.log("RUNNING COMPLETE HVAC FRONTEND CHALLENGER & REGRESSION TEST SUITE");
console.log("=================================================================\n");

// Suite 1: Spoken-text normalization & clause splitting
console.log("--- 1. Spoken-Text Normalization & Clause Splitting Tests ---");
const { passed, failed } = runAllTests();
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} total\n`);
if (failed > 0) {
  process.exit(1);
}

// Suites to execute in child processes
const suites = [
  { name: "Lifecycle & Mobile Continuity", path: "lifecycle.challenge.test.ts", stripTypes: true },
  { name: "Client Platform & Telemetry", path: "telemetry.test.ts", stripTypes: true },
  { name: "Touch Targets & Viewports", path: "stress-touch-target-challenger.mjs", stripTypes: false },
  { name: "Audio Player Audit", path: "test-audio-audit.mjs", stripTypes: false },
  { name: "Audio Context Unlock & Stress", path: "stress-audio-challenger.mjs", stripTypes: false },
  { name: "Speech Recognition Challenge", path: "speech-recognition.challenge.test.ts", stripTypes: true },
];

for (const suite of suites) {
  console.log(`\n=================================================================`);
  console.log(`RUNNING: ${suite.name} (${suite.path})`);
  console.log(`=================================================================`);

  const args = suite.stripTypes
    ? ["--experimental-strip-types", join(__dirname, suite.path)]
    : [join(__dirname, suite.path)];

  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    cwd: join(__dirname, "../.."),
  });

  if (result.status !== 0) {
    console.error(`\nFAILED: Suite ${suite.name} exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n=================================================================");
console.log("ALL FRONTEND CHALLENGER & REGRESSION SUITES PASSED (100%)");
console.log("=================================================================");
