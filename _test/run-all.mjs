// Run every suite as its own child process.
//
// Separate processes matter here: each suite builds its own `new Function`
// copy of the plugin, and a shared process would let one suite's internals
// leak into another's via the module cache. The e2e suite also writes files
// into the sandbox output directory, and a fresh process keeps that from
// affecting the other suites' assumptions.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
	"test-logic.mjs",
	"test-integration.mjs",
	"test-e2e.mjs"
];

let failed = 0;
const summary = [];

for (const suite of SUITES) {
	const result = spawnSync(process.execPath, [join(here, suite)], {
		stdio: "inherit",
		cwd: join(here, "..")
	});
	if (result.status !== 0) failed += 1;
	summary.push(`${suite}: ${result.status === 0 ? "ok" : `FAILED (exit ${result.status})`}`);
}

console.log("");
console.log("browser: summary");
for (const line of summary) console.log(`  ${line}`);

if (failed > 0) {
	console.log(`\nbrowser: ${failed} of ${SUITES.length} suites failed.`);
	process.exit(1);
}
console.log(`\nbrowser: all ${SUITES.length} suites passed.`);