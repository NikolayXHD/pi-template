/**
 * Shared paths for the package live checks (the `live/` directory).
 *
 * `EXT` is the extension entry point, relative to this file. `PI` is the pi
 * SDK of the installation the checks run against: `pi-template` does not
 * depend on the SDK in its own `node_modules`. The SDK root is looked up in
 * the global `node_modules` of the `node` that runs the script (an nvm
 * install of pi) and in the pi managed install (`PI_MANAGED_INSTALL_ROOT`
 * releases).
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXT = fileURLToPath(new URL("../index.ts", import.meta.url));

/** Candidate `node_modules` roots of the pi SDK. */
function sdkRootCandidates() {
	const roots = [join(dirname(dirname(process.execPath)), "lib", "node_modules")];
	const managed = process.env.PI_MANAGED_INSTALL_ROOT;
	if (managed !== undefined) {
		const releases = join(resolve(managed), "releases");
		const versions = existsSync(releases) ? readdirSync(releases).sort().reverse() : [];
		for (const version of versions) roots.push(join(releases, version, "node_modules"));
	}
	return roots;
}

/** SDK paths of one root: the package entry, its types and the node types. */
function sdkPathsOf(root) {
	const piRoot = join(root, "@earendil-works", "pi-coding-agent");
	const existing = (candidates) => candidates.find((path) => existsSync(path));
	return {
		entry: join(piRoot, "dist", "index.js"),
		piTypes: join(piRoot, "dist", "index.d.ts"),
		piTuiTypes: existing([
			join(root, "@earendil-works", "pi-tui", "dist", "index.d.ts"),
			join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.d.ts"),
		]),
		nodeTypeRoots: existing([join(root, "@types"), join(piRoot, "node_modules", "@types")]),
	};
}

const roots = sdkRootCandidates();
const sdk = roots.map(sdkPathsOf).find((paths) => existsSync(paths.entry));
if (sdk === undefined) {
	throw new Error(
		`pi SDK not found — tried ${roots.join(", ")}; run the check with the node pi is installed under`,
	);
}

export const PI = sdk.entry;
export const PI_TYPES = sdk.piTypes;
export const PI_TUI_TYPES = sdk.piTuiTypes;
export const NODE_TYPE_ROOTS = sdk.nodeTypeRoots;
