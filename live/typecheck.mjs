/**
 * Package type check: generates `tsconfig.json` in a temporary directory
 * (paths to the pi SDK and its types are machine-dependent and do not go
 * into the repository) and runs `tsc` from PATH. The SDK paths come from
 * `sdk.mjs` — the same lookup the live runs use.
 *
 * Run: node live/typecheck.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { NODE_TYPE_ROOTS, PI_TYPES, PI_TUI_TYPES } from "./sdk.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const typePaths = { piTypes: PI_TYPES, piTuiTypes: PI_TUI_TYPES, nodeTypeRoots: NODE_TYPE_ROOTS };
for (const [name, path] of Object.entries(typePaths)) {
	if (path === undefined || !existsSync(path)) {
		throw new Error(`pi SDK types not found: ${name} — ${path ?? "no candidate"}`);
	}
}

const config = {
	compilerOptions: {
		noEmit: true,
		strict: true,
		target: "ES2022",
		module: "ESNext",
		moduleResolution: "bundler",
		allowImportingTsExtensions: true,
		skipLibCheck: true,
		types: ["node"],
		typeRoots: [NODE_TYPE_ROOTS],
		paths: {
			"@earendil-works/pi-coding-agent": [PI_TYPES],
			"@earendil-works/pi-tui": [PI_TUI_TYPES],
		},
	},
	include: [join(packageRoot, "*.ts")],
};

const dir = mkdtempSync(join(tmpdir(), "pi-template-tsc-"));
const configPath = join(dir, "tsconfig.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const result = spawnSync("tsc", ["--project", configPath], { stdio: "inherit" });
rmSync(dir, { recursive: true, force: true });
if (result.error) {
	console.error(`tsc did not start: ${result.error.message} — tsc is required in PATH`);
	process.exitCode = 1;
} else if (result.status !== 0) {
	console.error("TYPECHECK FAIL");
	process.exitCode = result.status ?? 1;
} else {
	console.log("TYPECHECK OK");
}
