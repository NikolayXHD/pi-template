/**
 * Source list and include resolution.
 *
 * A source is an `X.template` file; the target file `X` appears next to it.
 * The list mirrors the consumers of pi and pi-subagents: context files
 * (candidates `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`,
 * `CLAUDE.MD` in the agent directory and up the cwd chain), `SYSTEM.md`,
 * `APPEND_SYSTEM.md`, `skills/**`, `prompts/**`, `agents/**` of the agent
 * directory and the `.pi/` counterparts of the project, agent files of
 * legacy `.agents` and `~/.agents` (pi-subagents), `.agents/skills` skills
 * of cwd ancestors and `~/.agents/skills` (pi). Non-template files are not
 * in the list: consumers read them directly.
 *
 * Includes are resolved on disk at render time (see `createPartialResolver`):
 * there is no pre-traversal of directories, so an include from an arbitrary
 * directory (for example `modes/`) resolves as well as one next to a source.
 *
 * We do not reproduce pi's worktree mechanics (shadowing a context file of
 * the main repository): an extra target file is harmless, a missed source is
 * a raw tag in a foreign read. A directory read error (not "no directory")
 * goes to warnings, not a silent skip.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { collectIncludeNames } from "./render.ts";
import type { PartialResolver } from "./render.ts";

export type SourceKind = "context" | "system" | "append" | "skill" | "prompt" | "agent" | "include";

export interface TemplateSource {
	/** Absolute path of the `X.template` source. */
	source: string;
	/** Absolute path of the target file `X`. */
	target: string;
	kind: SourceKind;
}

/** Context file candidates — as in pi (`resource-loader`). */
export const CONTEXT_CANDIDATES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
] as const;

const TEMPLATE_SUFFIX = ".template";
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_WALK_DEPTH = 12;
const MAX_WALK_FILES = 5000;

export interface SourceDiscoveryOptions {
	/** Root of `~/.agents`; the home directory by default. */
	homeDir?: string;
	/** Warning collector (directory read errors). */
	problems?: string[];
}

interface WalkOptions {
	problems?: string[];
	depth?: number;
	/** Subdirectories we do not walk (e.g. `skills` inside `~/.agents`). */
	skipDirNames?: ReadonlySet<string>;
}

function errorCode(error: unknown): string | undefined {
	return (error as { code?: string } | null)?.code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Directory read without exceptions; "no directory" is silent, other errors go to problems. */
function readDirEntries(root: string, problems?: string[]) {
	try {
		return readdirSync(root, { withFileTypes: true });
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			problems?.push(`directory ${root} cannot be read: ${errorMessage(error)}`);
		}
		return [];
	}
}

/** Recursive directory walk: sorted files, skipping node_modules/.git. */
function walkFiles(root: string, options: WalkOptions = {}): string[] {
	const depth = options.depth ?? 0;
	if (!existsSync(root) || depth > MAX_WALK_DEPTH) return [];
	const files: string[] = [];
	const entries = readDirEntries(root, options.problems);
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		if (files.length >= MAX_WALK_FILES) break;
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name) || options.skipDirNames?.has(entry.name)) continue;
			files.push(...walkFiles(path, { ...options, depth: depth + 1 }));
			continue;
		}
		let isFile = entry.isFile();
		if (!isFile && entry.isSymbolicLink()) {
			try {
				isFile = statSync(path).isFile();
			} catch {
				isFile = false;
			}
		}
		if (isFile) files.push(path);
	}
	return files;
}

/** Directories from `dir` up to the filesystem root, inclusive. */
function ancestorDirs(dir: string): string[] {
	const dirs: string[] = [];
	let current = dir;
	for (;;) {
		dirs.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function addTemplatePair(
	pairs: Map<string, TemplateSource>,
	dir: string,
	targetName: string,
	kind: SourceKind,
): void {
	const source = join(dir, `${targetName}${TEMPLATE_SUFFIX}`);
	if (!existsSync(source)) return;
	const target = join(dir, targetName);
	if (pairs.has(source)) return;
	pairs.set(source, { source, target, kind });
}

function addWalkedTemplates(
	pairs: Map<string, TemplateSource>,
	root: string,
	kind: SourceKind,
	options?: WalkOptions,
): void {
	for (const file of walkFiles(root, options)) {
		if (!file.endsWith(TEMPLATE_SUFFIX)) continue;
		if (pairs.has(file)) continue;
		pairs.set(file, { source: file, target: file.slice(0, -TEMPLATE_SUFFIX.length), kind });
	}
}

/**
 * Source list: the agent directory, the project `.pi/`, the cwd ancestor
 * chain, legacy and user `.agents` roots. Returns a list sorted by source
 * path.
 */
export function discoverSources(
	agentDir: string,
	projectDir: string,
	options: SourceDiscoveryOptions = {},
): TemplateSource[] {
	const pairs = new Map<string, TemplateSource>();
	const resolvedAgentDir = resolve(agentDir);
	const resolvedProjectDir = resolve(projectDir);
	const home = resolve(options.homeDir ?? homedir());
	const problems = options.problems;

	for (const name of CONTEXT_CANDIDATES) addTemplatePair(pairs, resolvedAgentDir, name, "context");
	for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
		const kind: SourceKind = name === "SYSTEM.md" ? "system" : "append";
		addTemplatePair(pairs, resolvedAgentDir, name, kind);
		addTemplatePair(pairs, join(resolvedProjectDir, ".pi"), name, kind);
	}
	addWalkedTemplates(pairs, join(resolvedAgentDir, "skills"), "skill", { problems });
	addWalkedTemplates(pairs, join(resolvedProjectDir, ".pi", "skills"), "skill", { problems });
	addWalkedTemplates(pairs, join(resolvedAgentDir, "prompts"), "prompt", { problems });
	addWalkedTemplates(pairs, join(resolvedProjectDir, ".pi", "prompts"), "prompt", { problems });
	addWalkedTemplates(pairs, join(resolvedAgentDir, "agents"), "agent", { problems });
	addWalkedTemplates(pairs, join(resolvedProjectDir, ".pi", "agents"), "agent", { problems });
	// Legacy project directory: `skills` inside `.agents` are pi skills, not agents.
	addWalkedTemplates(pairs, join(resolvedProjectDir, ".agents"), "agent", {
		skipDirNames: new Set(["skills"]),
		problems,
	});
	// pi-subagents agents: ~/.agents is read whole, except `skills`
	// (the pi skills directory, not agents).
	addWalkedTemplates(pairs, join(home, ".agents"), "agent", {
		skipDirNames: new Set(["skills"]),
		problems,
	});
	// pi skills from `.agents/skills`: at cwd ancestors and in the home directory.
	for (const dir of ancestorDirs(resolvedProjectDir)) {
		addWalkedTemplates(pairs, join(dir, ".agents", "skills"), "skill", { problems });
	}
	addWalkedTemplates(pairs, join(home, ".agents", "skills"), "skill", { problems });

	let dir = resolvedProjectDir;
	for (;;) {
		for (const name of CONTEXT_CANDIDATES) addTemplatePair(pairs, dir, name, "context");
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return [...pairs.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/**
 * Include sources and the files nothing includes.
 *
 * A `.template` file is an include source when a template mentions its name
 * — a static one, a dynamic one for every value of the variable value lists
 * — directly or through another include. Its target `X` is written like the
 * target of any other source; a name that resolves to a plain `X` (no
 * `X.template`) is hand-written and is never ours.
 *
 * `notIncluded` — `.template` files of the directories that hold sources and
 * includes and are mentioned nowhere: no target exists for them, and the
 * rewrite report names them. The candidates of every mentioned name (`X.template`,
 * `X`) go to `paths`: the session stamps them, so an edit, an appearance or a
 * removal marks the context stale.
 */
export interface IncludeDiscoveryOptions {
	/** Sources the includes are followed from. */
	sources: readonly TemplateSource[];
	agentDir: string;
	projectDir: string;
	/** Variable name → known value list — a dynamic include name resolves over it. */
	variables: Record<string, string[] | undefined>;
	/** Problems: a template text that cannot be read or parsed. */
	problems?: string[];
}

export interface IncludeDiscovery {
	/** Include sources: mentioned `X.template` files. */
	sources: TemplateSource[];
	/** Both candidates of every mentioned include name. */
	paths: string[];
	/** `.template` files no template mentions — no target is written for them. */
	notIncluded: string[];
}

export function discoverIncludeSources(options: IncludeDiscoveryOptions): IncludeDiscovery {
	const bySource = new Map<string, TemplateSource>();
	const paths = new Set<string>();
	const visited = new Set<string>();
	const queue = options.sources.map((source) => source.source);
	while (queue.length > 0) {
		const path = queue.pop() as string;
		if (visited.has(path)) continue;
		visited.add(path);
		for (const name of includeNamesOf(path, options, options.problems)) {
			const pair = includePair(resolve(options.agentDir), resolve(options.projectDir), name);
			if (pair === undefined) continue;
			for (const candidate of pair) paths.add(candidate);
			const [sourcePath, target] = pair;
			if (!isFile(sourcePath) || bySource.has(sourcePath)) continue;
			bySource.set(sourcePath, { source: sourcePath, target, kind: "include" });
			queue.push(sourcePath);
		}
	}
	return {
		sources: [...bySource.values()].sort((a, b) => (a.source < b.source ? -1 : 1)),
		paths: [...paths].sort(),
		notIncluded: notIncludedFiles(options, paths, new Set(bySource.keys())),
	};
}

/** Include names of one template file; a text that cannot be read or parsed is a problem. */
function includeNamesOf(
	path: string,
	options: IncludeDiscoveryOptions,
	problems: string[] | undefined,
): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		problems?.push(`${path}: source cannot be read: ${errorMessage(error)}`);
		return [];
	}
	const collected = collectIncludeNames(text, options.variables);
	if (collected.problem !== null) {
		problems?.push(`${path}: ${collected.problem}`);
		return [];
	}
	return collected.names;
}

/** `.template` files of the directories of sources and includes that nothing mentions. */
function notIncludedFiles(
	options: IncludeDiscoveryOptions,
	mentionedPaths: ReadonlySet<string>,
	includeSources: ReadonlySet<string>,
): string[] {
	const known = new Set([...options.sources.map((source) => source.source), ...includeSources]);
	const dirs = new Set<string>();
	for (const source of options.sources) dirs.add(dirname(source.source));
	for (const path of mentionedPaths) dirs.add(dirname(path));
	const found: string[] = [];
	for (const dir of [...dirs].sort()) {
		for (const entry of readDirEntries(dir, options.problems)) {
			if (!entry.name.endsWith(TEMPLATE_SUFFIX)) continue;
			const path = join(dir, entry.name);
			if (known.has(path) || !isFile(path)) continue;
			found.push(path);
		}
	}
	return found.sort();
}

/**
 * Include resolver over the two roots: the name is a path from the root of
 * its directory — the agent directory without a prefix, the project root
 * with the `.pi/` prefix. The text comes from `X.template` when present,
 * otherwise from `X`; existence and text are checked at call time, so an
 * include added to the disk is visible without a directory walk. A name
 * that escapes its root is not resolved. `paths` carries both candidates
 * (`X.template`, `X`) of every include the render read or tried to read:
 * the session stamps them, so an edit, appearance or removal of either
 * marks the context stale.
 */
export interface DiskPartialResolver extends PartialResolver {
	/** Both candidates of every include read (or attempted) so far. */
	readonly paths: ReadonlySet<string>;
}

/** Include name of the project root: the `.pi/` prefix in the name. */
export const PROJECT_PREFIX = ".pi/";

/** Candidate files of an include name; `undefined` — the name escapes its root. */
function includePair(agentRoot: string, projectRoot: string, name: string): [string, string] | undefined {
	const root = name.startsWith(PROJECT_PREFIX) ? projectRoot : agentRoot;
	const path = resolve(root, name);
	if (path !== root && !path.startsWith(`${root}${sep}`)) return undefined;
	return [`${path}${TEMPLATE_SUFFIX}`, path];
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Disk include resolver: reads are cached per instance (a render pass),
 * nested includes are served from the same cache. A file present but
 * unreadable is an exception naming the include, not a silent miss.
 */
export function createPartialResolver(agentDir: string, projectDir: string): DiskPartialResolver {
	const agentRoot = resolve(agentDir);
	const projectRoot = resolve(projectDir);
	const pairs = new Map<string, [string, string] | undefined>();
	const texts = new Map<string, string>();
	const paths = new Set<string>();

	const pairOf = (name: string): [string, string] | undefined => {
		if (!pairs.has(name)) pairs.set(name, includePair(agentRoot, projectRoot, name));
		return pairs.get(name);
	};
	const pathOf = (name: string): string | undefined => pairOf(name)?.find((path) => isFile(path));

	return {
		paths,
		exists: (name) => pathOf(name) !== undefined,
		read: (name) => {
			const pair = pairOf(name);
			if (pair !== undefined) for (const path of pair) paths.add(path);
			const path = pathOf(name);
			if (path === undefined) return undefined;
			const cached = texts.get(path);
			if (cached !== undefined) return cached;
			let text: string;
			try {
				text = readFileSync(path, "utf-8");
			} catch (error) {
				throw new Error(`partial "${name}" cannot be read (${path}): ${errorMessage(error)}`);
			}
			texts.set(path, text);
			return text;
		},
	};
}
