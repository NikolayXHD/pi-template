/**
 * Session context version lifecycle: a full view at start, two versions
 * (applied and current), source comparison, applying and consumption
 * points (the prompt, foreign reads of target files, spawn, the agent file
 * catalog).
 *
 * Rules:
 * - computed variables are calculated at start and on explicit menu
 *   commands; editing a source re-renders the current version without
 *   recomputing computed ones;
 * - there are no automatic applies: the applied version changes only at
 *   session start, when the actual model is checked on the first turn, by
 *   the apply button (API for zone C) and by `/reload` (writing the current
 *   version on `session_shutdown` before pi re-reads the target files);
 * - foreign reads (read tool, spawn, catalog) run under a lock and get
 *   the applied version variant; a render failure does not rewrite the
 *   target file (last-success cache), and a loud warning names the reason;
 *   a broken `template.json` means the view is not built, no re-render.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type AgentFilePreliminary, type HeaderParser, renderAgentFile, splitThinkingSuffix } from "./agent.ts";
import { agentNameFromPrompt, agentNameFromSessionName, hasActiveAgentTag } from "./identity.ts";
import { type LockHandle, acquireLock, releaseLock, writeTargetUnderLock } from "./lock.ts";
import {
	type SubagentRenderView,
	agentNameOf,
	renderSource,
	renderSources,
} from "./render-set.ts";
import { CONTEXT_CANDIDATES, type TemplateSource, createPartialResolver, discoverSources } from "./sources.ts";
import { ContextVersions, type ContextVersion, sourceStamps, stampsDiffer } from "./versions.ts";
import {
	IMPLICIT_VARIABLE_NAMES,
	type ShellExecutor,
	type VarsConfig,
	computeView,
	evaluateExpressions,
	isBooleanValue,
	isBooleanVariable,
	isComputedVariable,
	isDerivedVariable,
	loadVarsConfig,
	writeStatusVariable,
} from "./vars.ts";

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

/** Session host: everything zone B takes from the pi context. */
export interface TemplateSessionHost {
	/** Actual session model `provider/modelId`. */
	model?: string;
	/** Actual thinking level. */
	level?: string;
	/** Current system prompt (carrier of the `<active_agent>` tag). */
	systemPrompt?: string;
	/** Session name — the fallback identity channel. */
	sessionName?: string;
	/** Session overrides (`customType: "var"`, last value). */
	overrides?: Record<string, string>;
	/** Whether the project is trusted: this drives the choice of pi project sources. */
	projectTrusted?: boolean;
	/** Loud UI warning (deduplication is on the session side). */
	warn(message: string): void;
}

/** System prompt sections updated by pointwise replacement. */
export interface PromptSectionFile {
	path: string;
	content: string;
}

export interface PromptSectionSourceInfo {
	path: string;
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	baseDir?: string;
}

export interface PromptSectionSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: PromptSectionSourceInfo;
	disableModelInvocation: boolean;
}

export interface PromptSections {
	contextFiles?: PromptSectionFile[];
	skills?: PromptSectionSkill[];
	customPrompt?: string;
	appendSystemPrompt?: string;
}

export interface PromptEvent {
	systemPrompt?: string;
	systemPromptOptions: PromptSections;
}

export interface TemplateSessionOptions {
	agentDir: string;
	projectDir: string;
	parseHeader: HeaderParser;
	/** Shell executor override — tests; the system shell by default. */
	execute?: ShellExecutor;
	env?: Record<string, string | undefined>;
	/** Home directory for `~/.agents` roots; the home directory by default. */
	homeDir?: string;
	/** Lock scope of this session (a parent and process children do not share depth). */
	lockScope?: string;
	now?: () => number;
}

interface SpawnTarget {
	name: string;
	model?: string;
}

interface ChildView {
	view: Record<string, string>;
	values: Record<string, string[] | undefined>;
}

/** Holder of a foreign-read lock: released on `tool_execution_end`. */
export interface TargetBracket {
	handle: LockHandle;
}

export class TemplateSession {
	private readonly agentDir: string;
	private readonly projectDir: string;
	private readonly parseHeader: HeaderParser;
	private readonly execute: ShellExecutor | undefined;
	private readonly env: Record<string, string | undefined>;
	private readonly homeDir: string;
	private readonly lockScope: string;
	private readonly now: () => number;

	private host: TemplateSessionHost | undefined;
	private readonly warned = new Set<string>();

	private config: VarsConfig | undefined;
	private statusVariableName: string | undefined;
	private agentName: string | undefined;
	private projectTrusted = false;
	private startReason: SessionStartReason = "startup";
	private started = false;

	private view: Record<string, string> = {};
	private values: Record<string, string[] | undefined> = {};
	private overrides: Record<string, string> = {};
	private computedAt: Record<string, number> = {};
	private problems: string[] = [];
	private warnings: string[] = [];

	private sources: TemplateSource[] = [];
	/** Files of the includes the last current-version render read (or tried). */
	private partialPaths: string[] = [];
	private stamps: Record<string, string> = {};
	/** `template.json` stamp: the config is re-read when the file changes. */
	private configStamps: Record<string, string> = {};
	/** Problems of the last render pass (per-file failures). */
	private lastRenderProblems: readonly string[] = [];
	private startupTexts: Record<string, string> = {};
	/** Sections pi actually loaded for SYSTEM/APPEND — "ours/foreign" recognition. */
	private piLoadedSections: { customPrompt?: string; appendSystemPrompt?: string } | undefined;
	private childViews = new Map<string, ChildView>();

	private readonly versions = new ContextVersions();
	private applied: Record<string, string> = {};
	private pendingDelivery = false;
	private readonly brackets = new Set<TargetBracket>();

	constructor(options: TemplateSessionOptions) {
		this.agentDir = resolve(options.agentDir);
		this.projectDir = resolve(options.projectDir);
		this.parseHeader = options.parseHeader;
		this.execute = options.execute;
		this.env = options.env ?? process.env;
		this.homeDir = resolve(options.homeDir ?? homedir());
		this.lockScope = options.lockScope ?? randomBytes(8).toString("hex");
		this.now = options.now ?? Date.now;
	}

	attachHost(host: TemplateSessionHost): void {
		this.host = host;
	}

	private warn(message: string): void {
		if (this.warned.has(message)) return;
		this.warned.add(message);
		this.host?.warn(message);
	}

	private noteWarnings(messages: readonly string[]): void {
		for (const message of messages) {
			if (!this.warnings.includes(message)) this.warnings.push(message);
			this.warn(message);
		}
	}

	private noteProblems(messages: readonly string[]): void {
		for (const message of messages) {
			if (!this.problems.includes(message)) this.problems.push(message);
			this.warn(message);
		}
	}

	/**
	 * Session start: a full view (machine values, overrides, implicit
	 * model/level), current version render. Start is an explicit apply: the
	 * current version is written to the target files and delivered by section
	 * replacement on the first before_agent_start (pi read the target files
	 * before session_start). After `/reload` the new instance takes the target
	 * files as the applied version and renders the current one anew.
	 */
	async start(host: TemplateSessionHost, reason: SessionStartReason): Promise<void> {
		this.attachHost(host);
		this.startReason = reason;
		this.projectTrusted = host.projectTrusted === true;
		this.detectIdentity(host);
		const loaded = loadVarsConfig(this.agentDir, this.env);
		if ("problem" in loaded) {
			this.warn(`${loaded.problem} — view not built, no re-render`);
			return;
		}
		this.config = loaded;
		this.statusVariableName = loaded.statusVariable;
		this.discoverInputs();
		if (reason === "reload") {
			// The disk is the source of truth for the applied version: the new
			// runtime takes what is in the target files as applied.
			this.versions.setApplied({ texts: { ...this.startupTexts }, view: {} });
		}
		await this.ensureStarted(host);
	}

	private detectIdentity(host: TemplateSessionHost): void {
		const fromPrompt = host.systemPrompt ? agentNameFromPrompt(host.systemPrompt) : undefined;
		if (fromPrompt !== undefined) {
			this.agentName = fromPrompt;
			return;
		}
		const fromName = agentNameFromSessionName(host.sessionName);
		if (fromName !== undefined) {
			this.agentName = fromName;
			this.warn(
				`no <active_agent name="…"> tag in the system prompt — agent name "${fromName}" taken from the session name`,
			);
		}
	}

	/** Sources, stamps and startup target file texts. */
	private discoverInputs(): void {
		const { sources, problems } = this.discoverInputsOnce();
		this.sources = sources;
		this.noteProblems(problems);
		this.startupTexts = this.readTargetTexts();
		this.configStamps = sourceStamps([this.configPath()]);
		this.rememberStamps();
	}

	/** Source discovery with directory read warnings. */
	private discoverInputsOnce(): { sources: TemplateSource[]; problems: string[] } {
		const problems: string[] = [];
		const sources = discoverSources(this.agentDir, this.projectDir, { homeDir: this.homeDir, problems });
		return { sources, problems };
	}

	/** Build the view if model/level were missing at start (first turn). */
	private async ensureStarted(host: TemplateSessionHost): Promise<boolean> {
		if (this.started) return true;
		if (this.config === undefined) return false;
		if (!host.model || !host.level) {
			this.warn("model/level not determined — no re-render");
			return false;
		}
		await this.buildView(host);
		this.finishStart();
		this.started = true;
		return true;
	}

	private async buildView(host: TemplateSessionHost): Promise<void> {
		const config = this.config;
		if (config === undefined) return;
		this.childViews.clear();
		const implicit: Record<string, string> = {};
		if (host.model) implicit.model = host.model;
		if (host.level) implicit.level = host.level;
		const overrides: Record<string, string> = { ...this.overrides };
		for (const [name, value] of Object.entries(host.overrides ?? {})) {
			if (Object.hasOwn(config.vars, name) && !isImplicit(name)) overrides[name] = value;
		}
		for (const [name, value] of Object.entries(overrides)) {
			implicit[name] = value;
		}
		this.overrides = overrides;
		const report = await computeView({
			config,
			agentDir: this.agentDir,
			projectDir: this.projectDir,
			implicit,
			agentName: this.agentName,
			env: this.env,
			execute: this.execute,
		});
		this.view = report.view;
		this.values = report.values;
		this.recordComputedAges(Object.keys(config.vars));
		this.noteProblems(report.problems);
		this.noteWarnings(report.warnings);
		await this.renderCurrent();
	}

	private recordComputedAges(names: readonly string[]): void {
		if (this.config === undefined) return;
		const at = this.now();
		for (const name of names) {
			const spec = this.config.vars[name];
			if (spec !== undefined && isComputedVariable(spec, this.agentName)) this.computedAt[name] = at;
		}
	}

	private finishStart(): void {
		const current = this.versions.current;
		if (this.startReason === "reload") {
			// pi has already re-read the target files; delivery is not needed, the
			// current version exists for status and future applies.
			this.versions.setApplied({ texts: { ...this.startupTexts }, view: { ...this.view } });
			this.applied = { ...this.view };
			this.pendingDelivery = false;
			return;
		}
		if (current === null) return;
		this.versions.applyCurrent();
		this.applied = { ...this.view };
		this.pendingDelivery = true;
		this.writeVersion(current);
	}

	/** Re-render the current version under the current view (without recomputing computed). */
	private async renderCurrent(): Promise<void> {
		const partials = createPartialResolver(this.agentDir, this.projectDir);
		const report = await renderSources(
			this.sources,
			{
				view: this.view,
				variables: this.values,
				partials,
				parseHeader: this.parseHeader,
				subagentView: (name) =>
					this.childRenderView(name, { model: this.view.model ?? "", level: this.view.level ?? "" }, this.view),
			},
			(target) => this.readTargetText(target),
		);
		this.partialPaths = [...partials.paths];
		this.rememberStamps();
		this.lastRenderProblems = report.problems;
		this.noteProblems(report.problems);
		this.noteWarnings(report.warnings);
		this.versions.setCurrent({ texts: report.texts, view: { ...this.view } });
	}

	private childRenderView(
		agentName: string,
		preliminary: AgentFilePreliminary,
		parentView: Record<string, string>,
	): Promise<SubagentRenderView> | SubagentRenderView {
		const key = `${agentName}\u0000${preliminary.model}\u0000${preliminary.level}`;
		const cached = this.childViews.get(key);
		if (cached !== undefined) {
			return { parentView, subagentView: cached.view, preliminary };
		}
		return this.computeChildView(key, agentName, preliminary.model, preliminary.level).then((child) => ({
			parentView,
			subagentView: child.view,
			preliminary,
		}));
	}

	private async computeChildView(
		key: string,
		agentName: string,
		model: string,
		level: string,
	): Promise<ChildView> {
		const child: ChildView = { view: { model, level }, values: {} };
		if (this.config !== undefined) {
			const report = await computeView({
				config: this.config,
				agentDir: this.agentDir,
				projectDir: this.projectDir,
				implicit: { model, level },
				agentName,
				env: this.env,
				execute: this.execute,
			});
			child.view = report.view;
			child.values = report.values;
			this.noteProblems(report.problems);
			this.noteWarnings(report.warnings);
		}
		this.childViews.set(key, child);
		return child;
	}

	/**
	 * Turn: source comparison (mtime+size, without recomputing computed) and
	 * delivery of the applied version by section replacement; on the first
	 * turn — actual model check and apply.
	 */
	async beforeAgentStart(event: PromptEvent, host: TemplateSessionHost): Promise<void> {
		this.attachHost(host);
		// Sections pi actually loaded — a snapshot before our mutations: it
		// identifies SYSTEM/APPEND (the disk could have been rewritten elsewhere).
		if (this.piLoadedSections === undefined) {
			this.piLoadedSections = {
				customPrompt: typeof event.systemPromptOptions.customPrompt === "string" ? event.systemPromptOptions.customPrompt : undefined,
				appendSystemPrompt:
					typeof event.systemPromptOptions.appendSystemPrompt === "string"
						? event.systemPromptOptions.appendSystemPrompt
						: undefined,
			};
		}
		if (this.agentName === undefined && event.systemPrompt) {
			const fromPrompt = agentNameFromPrompt(event.systemPrompt);
			if (fromPrompt !== undefined) {
				// pane-native: the tag appears only by before_agent_start.
				this.agentName = fromPrompt;
				if (this.started) {
					await this.buildView(host);
					this.versions.applyCurrent();
					const current = this.versions.current;
					this.applied = { ...this.view };
					this.pendingDelivery = true;
					if (current !== null) this.writeVersion(current);
				}
			}
		}
		if (!(await this.ensureStarted(host))) return;
		if (this.pendingDelivery) {
			// Start apply: the current version was fixed back in finishStart; the
			// actual model check is the second (and last) reason to move it.
			const corrected = await this.checkActualModel(host);
			if (corrected) {
				this.versions.applyCurrent();
				this.applied = { ...this.view };
			}
			const applied = this.versions.applied;
			if (applied !== null) this.writeVersion(applied);
			this.pendingDelivery = false;
		}
		// Source comparison runs after applying: editing a source in this same
		// turn marks the context stale but is not applied to the prompt. A
		// config edit is picked up the same way.
		await this.refreshConfig();
		await this.refreshSources();
		this.deliver(event.systemPromptOptions);
	}

	/** Model/level change during the session: re-render the current version, do not apply. */
	async onModelChanged(host: TemplateSessionHost): Promise<void> {
		this.attachHost(host);
		if (!this.started) return;
		if (!host.model || !host.level) return;
		if (host.model === this.view.model && host.level === this.view.level) return;
		this.view.model = host.model;
		this.view.level = host.level;
		this.childViews.clear();
		this.refreshExpressions();
		await this.renderCurrent();
	}

	/**
	 * A session name appeared but the tag is missing: the fallback channel
	 * with a loud warning (pi-subagents convention). `@` values are applied to
	 * the current version; the applied one does not change — the context is
	 * marked stale and applied explicitly.
	 */
	async onSessionName(name: string | undefined, host: TemplateSessionHost): Promise<void> {
		if (this.agentName !== undefined) return;
		const fromName = agentNameFromSessionName(name);
		if (fromName === undefined) return;
		this.attachHost(host);
		this.agentName = fromName;
		this.warn(
			`no <active_agent name="…"> tag in the system prompt — agent name "${fromName}" taken from the session name`,
		);
		if (this.started && this.config !== undefined) await this.buildView(host);
	}

	private async checkActualModel(host: TemplateSessionHost): Promise<boolean> {
		if (!host.model || !host.level) return false;
		if (host.model === this.view.model && host.level === this.view.level) return false;
		// CLI flags are not part of the startup view: the actual model re-renders
		// the current version and is delivered by the same section replacement.
		this.view.model = host.model;
		this.view.level = host.level;
		this.childViews.clear();
		this.refreshExpressions();
		await this.renderCurrent();
		return true;
	}

	private async refreshSources(): Promise<boolean> {
		const { sources, problems } = this.discoverInputsOnce();
		this.noteProblems(problems);
		const paths = [...sources.map((source) => source.source), ...this.partialPaths];
		const stamps = sourceStamps(paths);
		if (!stampsDiffer(this.stamps, stamps)) return false;
		this.sources = sources;
		await this.renderCurrent();
		return true;
	}

	private rememberStamps(): void {
		this.stamps = sourceStamps([...this.sources.map((source) => source.source), ...this.partialPaths]);
	}

	private readTargetText(target: string): string | undefined {
		try {
			return readFileSync(target, "utf-8");
		} catch {
			return undefined;
		}
	}

	private readTargetTexts(): Record<string, string> {
		const texts: Record<string, string> = {};
		for (const source of this.sources) {
			const text = this.readTargetText(source.target);
			if (text !== undefined) texts[source.target] = text;
		}
		return texts;
	}

	/** Write a version to the target files: only on a text mismatch, atomically. */
	private writeVersion(version: ContextVersion): number {
		let changed = 0;
		for (const [target, text] of Object.entries(version.texts)) {
			if (this.readTargetText(target) === text) continue;
			try {
				const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
				writeFileSync(temporary, text);
				renameSync(temporary, target);
				changed += 1;
			} catch (error) {
				this.warn(`target ${target} not written: ${errorMessage(error)}`);
			}
		}
		return changed;
	}

	/**
	 * Pointwise section replacement with the applied version text. Delivery
	 * rule: for each of our target files the section is either replaced (a
	 * record with our path already exists — pi read the target file before
	 * session_start) or added (no record — the target file did not exist when
	 * pi loaded; the first run after migration). Record order and shape follow
	 * pi. Foreign records are not touched: derived text (a CLI string, the
	 * child's effective prompt, a foreign context file) stays as is.
	 */
	private deliver(options: PromptSections): void {
		const applied = this.versions.applied;
		if (applied === null) return;
		const appliedTexts = normalizedTexts(applied.texts);
		this.deliverContextFiles(options, appliedTexts);
		this.deliverSkills(options, appliedTexts);
		const customPrompt = this.systemSection("SYSTEM.md", options.customPrompt, appliedTexts);
		if (customPrompt !== undefined) options.customPrompt = customPrompt;
		const appendSystemPrompt = this.systemSection("APPEND_SYSTEM.md", options.appendSystemPrompt, appliedTexts);
		if (appendSystemPrompt !== undefined) options.appendSystemPrompt = appendSystemPrompt;
	}

	/** Context files: replacing our records plus adding missing ones. */
	private deliverContextFiles(options: PromptSections, appliedTexts: Map<string, string>): void {
		const files = options.contextFiles ?? [];
		const present = new Set(files.map((file) => resolve(file.path)));
		options.contextFiles = files.map((file) => {
			const text = appliedTexts.get(resolve(file.path));
			return text === undefined ? file : { path: file.path, content: text };
		});
		for (const target of this.orderedContextTargets(appliedTexts)) {
			const path = resolve(target);
			if (present.has(path)) continue;
			const text = appliedTexts.get(path);
			if (text === undefined) continue;
			options.contextFiles.push({ path: target, content: text });
		}
	}

	/**
	 * pi context file order: the global agent directory, then cwd ancestors
	 * from the outside in; in each directory — the first existing candidate.
	 * We add only those that turned out to be our target files.
	 *
	 * Known limitation (accepted in review): the appearance of our
	 * `AGENTS.override.md` next to an already loaded foreign `AGENTS.md` does
	 * not displace the foreign record — we do not touch foreign records;
	 * protection of derived text beats form.
	 */
	private orderedContextTargets(appliedTexts: Map<string, string>): string[] {
		const seen = new Set<string>();
		const ordered: string[] = [];
		const addDir = (dir: string): void => {
			for (const name of CONTEXT_CANDIDATES) {
				const target = join(dir, name);
				if (!existsSync(target)) continue;
				const path = resolve(target);
				if (appliedTexts.has(path) && !seen.has(path)) {
					seen.add(path);
					ordered.push(path);
				}
				break;
			}
		};
		addDir(this.agentDir);
		const dirs: string[] = [];
		let dir = this.projectDir;
		for (;;) {
			dirs.push(dir);
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		for (const candidate of dirs.reverse()) addDir(candidate);
		return ordered;
	}

	/** Skills: replacing description, name and flag plus adding missing `SKILL.md`. */
	private deliverSkills(options: PromptSections, appliedTexts: Map<string, string>): void {
		const skills = options.skills ?? [];
		const present = new Set(skills.map((skill) => resolve(skill.filePath)));
		options.skills = skills.map((skill) => {
			const text = appliedTexts.get(resolve(skill.filePath));
			if (text === undefined) return skill;
			const facts = this.skillFacts(text, skill.filePath);
			return facts === undefined
				? skill
				: {
						...skill,
						name: facts.name,
						description: facts.description,
						disableModelInvocation: facts.disableModelInvocation,
					};
		});
		for (const source of this.sources) {
			if (source.kind !== "skill" || basename(source.target) !== "SKILL.md") continue;
			const target = resolve(source.target);
			if (present.has(target)) continue;
			const text = appliedTexts.get(target);
			if (text === undefined) continue;
			const entry = this.skillEntry(text, source.target);
			if (entry === undefined) continue;
			if (entry.sourceInfo.scope === "project" && !this.projectTrusted) continue;
			options.skills.push(entry);
		}
	}

	/** Skill entry from rendered frontmatter — the way pi's loader builds it. */
	private skillEntry(text: string, target: string): PromptSectionSkill | undefined {
		const facts = this.skillFacts(text, target);
		if (facts === undefined) return undefined;
		const baseDir = dirname(target);
		return {
			name: facts.name,
			description: facts.description,
			filePath: target,
			baseDir,
			sourceInfo: {
				path: target,
				source: "local",
				scope: this.underAgent(target) ? "user" : "project",
				origin: "top-level",
				baseDir,
			},
			disableModelInvocation: facts.disableModelInvocation,
		};
	}

	/** Skill facts from rendered text: name (fallback — the directory), description, flag. */
	private skillFacts(
		text: string,
		target: string,
	): { name: string; description: string; disableModelInvocation: boolean } | undefined {
		if (!text.startsWith("---")) return undefined;
		let parsed: Record<string, unknown>;
		try {
			parsed = this.parseHeader(text);
		} catch (error) {
			this.warn(`skill ${target}: frontmatter does not parse (${errorMessage(error)})`);
			return undefined;
		}
		const description = parsed.description;
		if (typeof description !== "string" || description.trim() === "") return undefined;
		const name =
			typeof parsed.name === "string" && parsed.name.trim() !== ""
				? parsed.name
				: basename(dirname(target));
		return { name, description, disableModelInvocation: parsed["disable-model-invocation"] === true };
	}

	private underAgent(path: string): boolean {
		const resolved = resolve(path);
		return resolved === this.agentDir || resolved.startsWith(`${this.agentDir}${sep}`);
	}

	/**
	 * SYSTEM/APPEND: recognition by the source pi chose (project `.pi/…` under
	 * trust, otherwise the agent one) and by the text actually loaded (a
	 * snapshot from the first `before_agent_start`, not from disk). A child's
	 * derived prompt (the `<active_agent>` tag) is never replaced; an SDK/CLI
	 * string cannot be told from a file — a miss is warned about, not silent.
	 */
	private systemSection(
		name: string,
		current: string | undefined,
		appliedTexts: Map<string, string>,
	): string | undefined {
		const projectTarget = resolve(join(this.projectDir, ".pi", name));
		const agentTarget = resolve(join(this.agentDir, name));
		const chosen =
			this.projectTrusted && existsSync(projectTarget)
				? projectTarget
				: existsSync(agentTarget)
					? agentTarget
					: undefined;
		if (chosen === undefined) return undefined;
		const appliedText = appliedTexts.get(chosen);
		if (appliedText === undefined) return undefined;
		if (typeof current !== "string" || current === "") {
			// No section: pi would have chosen our file if the target file had existed.
			return appliedText;
		}
		if (hasActiveAgentTag(current)) return undefined;
		const sectionName = name === "SYSTEM.md" ? "customPrompt" : "appendSystemPrompt";
		const piLoaded = this.piLoadedSections?.[sectionName];
		if (piLoaded !== undefined && !sameText(current, piLoaded)) {
			this.warn(`section ${name}: text changed after pi loaded it — applied version not delivered`);
			return undefined;
		}
		if (this.agentName !== undefined) {
			// Child: pi-subagents tags its own strings, here the source is a file.
			return appliedText;
		}
		if (this.recognizedTargetText(current, chosen, appliedText)) return appliedText;
		this.warn(
			`section ${name}: source not recognized as our target — replacement skipped (may be an explicit SDK/CLI prompt)`,
		);
		return undefined;
	}

	/** Known text of our target file: applied, startup or current on disk. */
	private recognizedTargetText(current: string, chosen: string, appliedText: string): boolean {
		if (sameText(current, appliedText)) return true;
		const startup = this.startupTexts[chosen];
		if (startup !== undefined && sameText(current, startup)) return true;
		const disk = this.readTargetText(chosen);
		return disk !== undefined && sameText(current, disk);
	}

	// ——— consumption points: foreign reads and spawn ———

	/**
	 * Foreign read bracket: a lock, source render under the applied version
	 * view, a write on mismatch. The lock is held until `tool_execution_end`.
	 * FS errors do not fail the tool call; exhausted retries after ownership
	 * loss give a warning, not a silent "read the previous text".
	 */
	async openReadBracket(targetPath: string): Promise<TargetBracket | null> {
		if (!this.started || this.versions.applied === null) return null;
		const target = resolve(targetPath);
		const source = this.sources.find((entry) => resolve(entry.target) === target);
		if (source === undefined) return null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const handle = await acquireLock(target, {
				scope: this.lockScope,
				onProblem: (message) => this.warn(message),
			});
			if (handle === null) {
				this.warn(`target ${target} is locked — reading without re-render`);
				return null;
			}
			let lost = false;
			try {
				const text = await this.renderForApplied(source);
				if (text !== undefined) {
					lost = writeTargetUnderLock(handle, text, (message) => this.warn(message)) === "lost";
				}
			} catch (error) {
				// Render and write warn themselves; here — a safety net against a throw.
				this.warn(`target ${target}: ${errorMessage(error)}`);
			}
			if (lost) {
				// Ownership lost — the target file was not written and a foreign lock was not released:
				// repeat the re-render.
				releaseLock(handle);
				continue;
			}
			const bracket: TargetBracket = { handle };
			this.brackets.add(bracket);
			return bracket;
		}
		this.warn(`target ${target}: ownership lost twice — the reader gets the previous text`);
		return null;
	}

	/**
	 * Spawn bracket: a lock and a two-stage render of agent files. Targets are
	 * taken by walking the arguments (`{agent: "name"}` in any shape); step
	 * model parameters found there are preliminary. No names found — all agent
	 * target files are re-rendered with session defaults. Locks are held until
	 * `tool_execution_end`; an error on a path releases what was taken and
	 * does not fail the spawn.
	 */
	async openSpawnBracket(input: unknown): Promise<TargetBracket[]> {
		if (!this.started) return [];
		const agents = this.sources.filter((source) => source.kind === "agent");
		if (agents.length === 0) return [];
		const targets = collectSpawnTargets(input);
		const byName = new Map(agents.map((source) => [agentNameOf(source.target), source]));
		const planned: Array<{ source: TemplateSource; preliminary: AgentFilePreliminary }> = [];
		const seen = new Set<string>();
		for (const target of targets) {
			const source = byName.get(target.name);
			if (source === undefined || seen.has(source.target)) continue;
			seen.add(source.target);
			planned.push({ source, preliminary: this.spawnPreliminary(target.model) });
		}
		if (planned.length === 0) {
			for (const source of agents) {
				seen.add(source.target);
				planned.push({
					source,
					preliminary: { model: this.applied.model ?? "", level: this.applied.level ?? "" },
				});
			}
		}
		planned.sort((a, b) => (a.source.target < b.source.target ? -1 : 1));
		const brackets: TargetBracket[] = [];
		try {
			for (const entry of planned) {
				const handle = await acquireLock(entry.source.target, {
					scope: this.lockScope,
					onProblem: (message) => this.warn(message),
				});
				if (handle === null) {
					this.warn(`target ${entry.source.target} is locked — the spawn reads the previous text`);
					continue;
				}
				const bracket: TargetBracket = { handle };
				try {
					const text = await this.renderForApplied(entry.source, entry.preliminary);
					if (text !== undefined) {
						const write = writeTargetUnderLock(handle, text, (message) => this.warn(message));
						if (write === "lost") {
							this.releaseBracket(bracket);
							this.warn(`lock ownership on ${entry.source.target} lost — spawn target not updated`);
							continue;
						}
					}
					this.brackets.add(bracket);
					brackets.push(bracket);
				} catch (error) {
					this.releaseBracket(bracket);
					this.warn(`${entry.source.source}: ${errorMessage(error)}`);
				}
			}
		} catch (error) {
			for (const bracket of brackets) this.releaseBracket(bracket);
			this.warn(`spawn bracket failed: ${errorMessage(error)}`);
			return [];
		}
		return brackets;
	}

	/**
	 * Preliminary agent render values on spawn: an explicit `model` (together
	 * with a `:level` suffix) wins over the header — as in pi-subagents; with
	 * no parameter — the applied session values.
	 */
	private spawnPreliminary(model: string | undefined): AgentFilePreliminary {
		const fallbackModel = this.applied.model ?? "";
		const fallbackLevel = this.applied.level ?? "";
		if (model === undefined || model === "") {
			return { model: fallbackModel, level: fallbackLevel };
		}
		const split = splitThinkingSuffix(model);
		return {
			model: split.model,
			level: split.suffix ?? fallbackLevel,
			explicitModel: true,
			explicitLevel: split.suffix !== undefined,
		};
	}

	/** Render a source under the applied version view; a failure gives a warning. */
	private async renderForApplied(
		source: TemplateSource,
		preliminary?: AgentFilePreliminary,
	): Promise<string | undefined> {
		const values: AgentFilePreliminary = preliminary ?? {
			model: this.applied.model ?? "",
			level: this.applied.level ?? "",
		};
		try {
			return await renderSource(source, {
				view: this.applied,
				variables: this.values,
				partials: createPartialResolver(this.agentDir, this.projectDir),
				parseHeader: this.parseHeader,
				subagentView: (name) => this.childRenderView(name, values, this.applied),
			});
		} catch (error) {
			this.warn(`${source.source}: ${errorMessage(error)}`);
			return undefined;
		}
	}

	releaseBracket(bracket: TargetBracket): void {
		this.brackets.delete(bracket);
		releaseLock(bracket.handle);
	}

	/** Runtime shutdown: `/reload` writes the current version before pi re-reads. */
	shutdown(reason: SessionShutdownReason): void {
		if (reason === "reload") {
			const current = this.versions.current;
			if (current !== null) this.writeVersion(current);
		}
		for (const bracket of [...this.brackets]) this.releaseBracket(bracket);
	}

	// ——— zone C API ———

	ready(): boolean {
		return this.started;
	}

	isStale(): boolean {
		return this.versions.stale();
	}

	currentView(): Record<string, string> {
		return { ...this.view };
	}

	/** Values of the applied context — the per-variable status reference. */
	appliedView(): Record<string, string> {
		return { ...this.applied };
	}

	currentValues(): Record<string, string[] | undefined> {
		return { ...this.values };
	}

	/** Name of the variable the status line shows (top-level `statusVariable`), if any. */
	statusVariable(): string | undefined {
		return this.statusVariableName;
	}

	sessionProblems(): readonly string[] {
		return this.problems;
	}

	sessionWarnings(): readonly string[] {
		return this.warnings;
	}

	computedAge(name: string): number | undefined {
		const at = this.computedAt[name];
		return at === undefined ? undefined : this.now() - at;
	}

	/** Apply button: the current version is written to the target files and delivered next turn. */
	apply(): boolean {
		const current = this.versions.current;
		if (!this.started || current === null) return false;
		this.versions.applyCurrent();
		this.applied = { ...this.view };
		this.pendingDelivery = true;
		this.writeVersion(current);
		return true;
	}

	/**
	 * Rewrite files button: target files on disk get the current version. There
	 * is no apply — versions, the applied context and session records are not
	 * touched; if the target files have run ahead of memory that is the normal
	 * "prompts are stale" (fixed by the apply button or a pi reload). The
	 * report says how many files changed and which failed to render.
	 */
	rewriteFiles(): { ok: boolean; changed: number; problems: readonly string[] } {
		const current = this.versions.current;
		if (!this.started || current === null) return { ok: false, changed: 0, problems: this.lastRenderProblems };
		return { ok: true, changed: this.writeVersion(current), problems: this.lastRenderProblems };
	}

	/** Session variable change: the current version is re-rendered, not applied. */
	async setVariable(name: string, value: string): Promise<{ ok: boolean; problem?: string }> {
		const config = this.config;
		if (!this.started || config === undefined) return { ok: false, problem: "view not built" };
		const spec = config.vars[name];
		if (spec === undefined) return { ok: false, problem: `variable "${name}" is not declared` };
		if (isImplicit(name)) return { ok: false, problem: `"${name}" is an implicit variable` };
		if (isComputedVariable(spec, this.agentName)) {
			return { ok: false, problem: `variable "${name}" is computed — override not allowed` };
		}
		if (isDerivedVariable(spec) && isBooleanVariable(name, config.vars) && !isBooleanValue(value)) {
			return { ok: false, problem: `variable "${name}": value "${value}" is not a boolean (true/false)` };
		}
		this.overrides[name] = value;
		this.view[name] = value;
		this.refreshExpressions();
		await this.renderCurrent();
		return { ok: true };
	}

	/**
	 * `alt+r`: write the status variable into `template.json` and adopt the
	 * re-read config: the file is validated anew. A write error leaves the
	 * current variable as is.
	 */
	saveStatusVariable(name: string): { ok: boolean; problem?: string } {
		if (!this.started) return { ok: false, problem: "view not built" };
		const written = writeStatusVariable(this.agentDir, name);
		if (!written.ok) return written;
		const loaded = loadVarsConfig(this.agentDir, this.env);
		if ("problem" in loaded) return { ok: false, problem: loaded.problem };
		this.statusVariableName = loaded.statusVariable;
		return { ok: true };
	}

	/**
	 * `template.json` is an input of the view: when the file changes, the
	 * config is re-read and the view is rebuilt (a config edit is an explicit
	 * action, so the shell values are recomputed too). A broken file keeps
	 * the previous config with a warning.
	 */
	async refreshConfig(): Promise<void> {
		const stamps = sourceStamps([this.configPath()]);
		if (!stampsDiffer(this.configStamps, stamps)) return;
		this.configStamps = stamps;
		const loaded = loadVarsConfig(this.agentDir, this.env);
		if ("problem" in loaded) {
			this.warn(`${loaded.problem} — keeping the previous config`);
			return;
		}
		this.config = loaded;
		this.statusVariableName = loaded.statusVariable;
		await this.recomputeAll();
	}

	private configPath(): string {
		return join(this.agentDir, "template.json");
	}

	/** Recompute all variables: an explicit menu command. */
	async recomputeAll(): Promise<{ ok: boolean; problem?: string }> {
		const config = this.config;
		if (!this.started || config === undefined) return { ok: false, problem: "view not built" };
		const report = await computeView({
			config,
			agentDir: this.agentDir,
			projectDir: this.projectDir,
			implicit: this.implicitView(),
			agentName: this.agentName,
			env: this.env,
			execute: this.execute,
		});
		this.view = report.view;
		this.values = report.values;
		this.recordComputedAges(Object.keys(config.vars));
		this.noteProblems(report.problems);
		this.noteWarnings(report.warnings);
		await this.renderCurrent();
		return report.problems.length === 0 ? { ok: true } : { ok: false, problem: report.problems[0] };
	}

	/** Recompute the given variable: the declaration chain up to it. */
	async recompute(name: string): Promise<{ ok: boolean; problem?: string }> {
		const config = this.config;
		if (!this.started || config === undefined) return { ok: false, problem: "view not built" };
		const spec = config.vars[name];
		if (spec === undefined) return { ok: false, problem: `variable "${name}" is not declared` };
		if (!isComputedVariable(spec, this.agentName)) {
			return { ok: false, problem: `variable "${name}" is not computed — nothing to recompute` };
		}
		const prefix: VarsConfig["vars"] = {};
		for (const item of Object.keys(config.vars)) {
			prefix[item] = config.vars[item];
			if (item === name) break;
		}
		const report = await computeView({
			config: { vars: prefix },
			agentDir: this.agentDir,
			projectDir: this.projectDir,
			implicit: this.implicitView(),
			agentName: this.agentName,
			env: this.env,
			execute: this.execute,
		});
		for (const item of Object.keys(prefix)) {
			if (report.view[item] !== undefined) this.view[item] = report.view[item];
			this.values[item] = report.values[item];
		}
		this.refreshExpressions();
		this.recordComputedAges(Object.keys(prefix));
		this.noteProblems(report.problems);
		this.noteWarnings(report.warnings);
		await this.renderCurrent();
		return report.problems.length === 0 ? { ok: true } : { ok: false, problem: report.problems[0] };
	}

	/** Implicit view values for recompute: model/level and session overrides. */
	private implicitView(): Record<string, string> {
		const implicit: Record<string, string> = { ...this.overrides };
		if (this.view.model !== undefined) implicit.model = this.view.model;
		if (this.view.level !== undefined) implicit.level = this.view.level;
		return implicit;
	}

	/**
	 * `compute` variables follow their inputs (model/level, overrides) —
	 * pure expressions are re-derived on every view change, unlike shell
	 * values, which are recomputed explicitly.
	 */
	private refreshExpressions(): void {
		const config = this.config;
		if (config === undefined) return;
		evaluateExpressions(config, this.view, {
			agentName: this.agentName,
			overridden: new Set(Object.keys(this.overrides)),
		});
	}
}

function isImplicit(name: string): boolean {
	return (IMPLICIT_VARIABLE_NAMES as readonly string[]).includes(name);
}

function sameText(left: string, right: string): boolean {
	return normalizeText(left) === normalizeText(right);
}

/** Target file texts with keys normalized to absolute paths (`resolve`). */
function normalizedTexts(texts: Readonly<Record<string, string>>): Map<string, string> {
	const normalized = new Map<string, string>();
	for (const [path, text] of Object.entries(texts)) normalized.set(resolve(path), text);
	return normalized;
}

function normalizeText(text: string): string {
	const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
	return withoutBom.replace(/\r\n?/g, "\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Spawn targets: a schema-free walk of the arguments — every object with a
 * string `agent` field; `model` is taken from the same object, otherwise
 * inherited from the enclosing one (step parameters over the session default).
 */
export function collectSpawnTargets(input: unknown): SpawnTarget[] {
	const targets: SpawnTarget[] = [];
	const seen = new Set<string>();
	const visit = (value: unknown, inheritedModel: string | undefined): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item, inheritedModel);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		const model = typeof record.model === "string" ? record.model : inheritedModel;
		if (typeof record.agent === "string" && record.agent !== "") {
			const key = `${record.agent}\u0000${model ?? ""}`;
			if (!seen.has(key)) {
				seen.add(key);
				targets.push({ name: record.agent, model });
			}
		}
		for (const [key, nested] of Object.entries(record)) {
			if (key === "agent") continue;
			visit(nested, model);
		}
	};
	visit(input, undefined);
	return targets;
}
