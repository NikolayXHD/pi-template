/**
 * pi-template — the extension entry point: the session context version
 * lifecycle and consumption points.
 *
 * Handler registration:
 * - `session_start` — full view, current version render, start apply
 *   (writing target files and delivery on the first turn), registering the
 *   extension as required for child sessions;
 * - `session_shutdown` — `/reload` writes the current version before pi
 *   re-reads the target files, releases locks, disposes the registration;
 * - `before_agent_start` — source comparison, actual model check on the
 *   first turn, pointwise section replacement with the applied version text;
 * - `model_select` / `thinking_level_select` — re-render the current
 *   version (without applying);
 * - `session_info_changed` — fallback identity channel: the session name
 *   when the `<active_agent>` tag is gone (loud warning);
 * - `tool_call` / `tool_execution_end` — lock brackets around foreign reads:
 *   the read tool (skill bodies) and subagent spawn (agent files, two-stage
 *   render with spawn parameters).
 *
 * Zone C: session overrides are read from `"var"` records at start
 * (resume) and written by the `/template` command; the `ctrl+r`/`alt+r`
 * shortcuts cycle the status variable value and the variable itself,
 * `ctrl+alt+r` applies the current version. The status line is updated at
 * start, on every turn and on explicit menu actions and shortcuts.
 *
 * External CLI and machine runs stay as in the design: registration
 * without `requireForAllRunners`, nothing is bypassed or masked.
 */

import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	isToolCallEventType,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { releaseLock } from "./lock.ts";
import { type TargetBracket, TemplateSession, type TemplateSessionHost } from "./session.ts";
import {
	type TemplateUiDeps,
	applyCurrentContext,
	clearTemplateStatus,
	cycleStatusVariable,
	cycleStatusVariableValue,
	registerTemplateCommand,
	updateTemplateStatus,
} from "./ui.ts";
import { readVarOverrides } from "./ui-model.ts";

/** Extension id in the pi-subagents required extensions registry. */
const REQUIRED_EXTENSION_ID = "pi-template";
/** Public pi-subagents export for required child extensions. */
const REQUIRED_EXTENSION_SPECIFIER = "pi-subagents/required-child-extensions";

interface RequiredChildRegistration {
	dispose(): void;
}

interface RequiredChildModule {
	registerRequiredChildExtensions(input: {
		sessionId: string;
		extensions: Array<{ id: string; path: string }>;
	}): RequiredChildRegistration;
}

/**
 * `registerRequiredChildExtensions` from pi-subagents: the documented
 * `pi-subagents/required-child-extensions` export. The agent directory is a
 * git package, so the bare import does not always resolve; then we try pi's
 * npm roots (`<agentDir>/npm/node_modules`, `<project>/.pi/npm/node_modules`).
 * Not resolved — one loud warning, work continues without registration
 * (best effort by design).
 */
let requiredModule: RequiredChildModule | undefined;
let requiredModulePromise: Promise<RequiredChildModule | undefined> | undefined;

async function loadRequiredChildModule(agentDir: string, projectDir: string): Promise<RequiredChildModule | undefined> {
	try {
		return (await import(REQUIRED_EXTENSION_SPECIFIER)) as RequiredChildModule;
	} catch {
		// Below — resolution via pi installation paths.
	}
	try {
		const require = createRequire(import.meta.url);
		const resolved = require.resolve(REQUIRED_EXTENSION_SPECIFIER, {
			paths: [join(agentDir, "npm", "node_modules"), join(projectDir, ".pi", "npm", "node_modules")],
		});
		return (await import(pathToFileURL(resolved).href)) as RequiredChildModule;
	} catch {
		return undefined;
	}
}

function loadRequiredChildModuleOnce(agentDir: string, projectDir: string): Promise<RequiredChildModule | undefined> {
	if (requiredModule !== undefined) return Promise.resolve(requiredModule);
	requiredModulePromise ??= loadRequiredChildModule(agentDir, projectDir).then((module) => {
		if (module !== undefined) requiredModule = module;
		else requiredModulePromise = undefined;
		return module;
	});
	return requiredModulePromise;
}

function parseHeader(text: string): Record<string, unknown> {
	return parseFrontmatter<Record<string, unknown>>(text).frontmatter;
}

/** Actual session model; CLI flags/settings are a fallback when ctx is empty. */
function resolveModel(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	if (ctx.model) return `${ctx.model.provider}/${ctx.model.id}`;
	const settings = pi.getSettings();
	if (settings.defaultProvider && settings.defaultModel) {
		const found = ctx.modelRegistry.find(settings.defaultProvider, settings.defaultModel);
		if (found) return `${found.provider}/${found.id}`;
	}
	const available = ctx.modelRegistry.getAvailable();
	return available.length > 0 ? `${available[0].provider}/${available[0].id}` : undefined;
}

function resolveLevel(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	return ctx.thinkingLevel ?? pi.getSettings().defaultThinkingLevel;
}

export default function piTemplate(pi: ExtensionAPI): void {
	const sessions = new Map<string, TemplateSession>();
	/** Session overrides: the last value of each `"var"` record. */
	const overrides = new Map<string, Record<string, string>>();
	/** Lock brackets per tool call: `<sessionId>\0<toolCallId>`. */
	const brackets = new Map<string, TargetBracket[]>();
	const registrations = new Map<string, RequiredChildRegistration>();
	const warned = new Set<string>();
	const entryPath = fileURLToPath(import.meta.url);

	const sessionIdOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();

	const warn = (ctx: ExtensionContext, message: string): void => {
		if (warned.has(message)) return;
		warned.add(message);
		try {
			ctx.ui.notify(message, "warning");
		} catch {
			// Stale context after a runtime replacement — the warning cannot be delivered.
		}
	};

	/** Session override map; before `session_start` it is restored from records. */
	const overridesOf = (ctx: ExtensionContext): Record<string, string> => {
		const sessionId = sessionIdOf(ctx);
		const existing = overrides.get(sessionId);
		if (existing !== undefined) return existing;
		const record = readVarOverrides(ctx.sessionManager.getEntries());
		overrides.set(sessionId, record);
		return record;
	};

	const hostOf = (ctx: ExtensionContext, sessionOverrides?: Record<string, string>): TemplateSessionHost => ({
		model: resolveModel(pi, ctx),
		level: resolveLevel(pi, ctx),
		systemPrompt: systemPromptOf(ctx),
		sessionName: ctx.sessionManager.getSessionName(),
		overrides: sessionOverrides,
		projectTrusted: projectTrustedOf(ctx),
		warn: (message) => warn(ctx, message),
	});

	const sessionOf = (ctx: ExtensionContext): TemplateSession | undefined => sessions.get(sessionIdOf(ctx));

	const bracketKey = (ctx: ExtensionContext, toolCallId: string): string => `${sessionIdOf(ctx)}\u0000${toolCallId}`;

	const addBrackets = (ctx: ExtensionContext, toolCallId: string, list: TargetBracket[]): void => {
		if (list.length === 0) return;
		const key = bracketKey(ctx, toolCallId);
		const existing = brackets.get(key);
		if (existing === undefined) brackets.set(key, [...list]);
		else existing.push(...list);
	};

	pi.on("session_start", async (event, ctx) => {
		const sessionId = sessionIdOf(ctx);
		const agentDir = getAgentDir();
		const session = new TemplateSession({
			agentDir,
			projectDir: ctx.cwd,
			parseHeader,
			lockScope: sessionId,
		});
		sessions.set(sessionId, session);
		// Resume: the last value of each variable from `"var"` records; old-format
		// records (`customType: "role"`) are not read.
		await session.start(hostOf(ctx, overridesOf(ctx)), event.reason);
		updateTemplateStatus(ctx, session);

		const module = await loadRequiredChildModuleOnce(agentDir, ctx.cwd);
		if (module === undefined) {
			warn(ctx, "pi-subagents/required-child-extensions not found — child sessions will not receive the extension");
			return;
		}
		try {
			registrations.set(
				sessionId,
				module.registerRequiredChildExtensions({
					sessionId,
					extensions: [{ id: REQUIRED_EXTENSION_ID, path: entryPath }],
				}),
			);
		} catch (error) {
			warn(ctx, `extension not registered as required for children: ${errorMessage(error)}`);
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const sessionId = sessionIdOf(ctx);
		sessions.get(sessionId)?.shutdown(event.reason);
		sessions.delete(sessionId);
		overrides.delete(sessionId);
		registrations.get(sessionId)?.dispose();
		registrations.delete(sessionId);
		clearTemplateStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const session = sessionOf(ctx);
		if (session === undefined) return;
		try {
			await session.beforeAgentStart(
				{ systemPrompt: event.systemPrompt, systemPromptOptions: event.systemPromptOptions },
				hostOf(ctx),
			);
			// The source comparison may have marked the context stale.
			updateTemplateStatus(ctx, session);
		} catch (error) {
			warn(ctx, `section delivery failed: ${errorMessage(error)}`);
		}
	});

	const onModelChange = async (ctx: ExtensionContext): Promise<void> => {
		const session = sessionOf(ctx);
		if (session === undefined) return;
		await session.onModelChanged(hostOf(ctx));
		updateTemplateStatus(ctx, session);
	};

	pi.on("model_select", async (_event, ctx) => {
		await onModelChange(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		await onModelChange(ctx);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		const session = sessionOf(ctx);
		if (session === undefined) return;
		await session.onSessionName(event.name, hostOf(ctx));
		updateTemplateStatus(ctx, session);
	});

	pi.on("tool_call", async (event, ctx) => {
		const session = sessionOf(ctx);
		if (session === undefined) return;
		try {
			if (isToolCallEventType("read", event)) {
				const bracket = await session.openReadBracket(resolve(ctx.cwd, event.input.path));
				if (bracket !== null) addBrackets(ctx, event.toolCallId, [bracket]);
				return;
			}
			if (isToolCallEventType<"subagent", Record<string, unknown>>("subagent", event)) {
				const list = await session.openSpawnBracket(event.input);
				addBrackets(ctx, event.toolCallId, list);
			}
		} catch (error) {
			// The bracket did not happen: we do not fail the tool call, locks are
			// released by the session itself (or by the TTL).
			warn(ctx, `lock bracket failed: ${errorMessage(error)}`);
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		try {
			const key = bracketKey(ctx, event.toolCallId);
			const list = brackets.get(key);
			if (list === undefined) return;
			brackets.delete(key);
			const session = sessionOf(ctx);
			for (const bracket of list) {
				if (session !== undefined) session.releaseBracket(bracket);
				else releaseLock(bracket.handle);
			}
		} catch (error) {
			warn(ctx, `lock release failed: ${errorMessage(error)}`);
		}
	});

	const deps: TemplateUiDeps = { sessionOf, overridesOf };
	registerTemplateCommand(pi, deps);
	pi.registerShortcut("ctrl+r", {
		description: "pi-template: cycle the value of the status variable",
		handler: (ctx) => cycleStatusVariableValue(pi, deps, ctx),
	});
	pi.registerShortcut("alt+r", {
		description: "pi-template: cycle the status variable",
		handler: (ctx) => cycleStatusVariable(deps, ctx),
	});
	pi.registerShortcut("ctrl+alt+r", {
		description: "pi-template: apply the current context",
		handler: (ctx) => applyCurrentContext(deps, ctx),
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The prompt may be unavailable in a narrow host mode — identity then has no tag. */
function systemPromptOf(ctx: ExtensionContext): string {
	try {
		return ctx.getSystemPrompt();
	} catch {
		return "";
	}
}

/** Project trust may be unavailable in a narrow host mode — treat as untrusted. */
function projectTrustedOf(ctx: ExtensionContext): boolean {
	try {
		return ctx.isProjectTrusted();
	} catch {
		return false;
	}
}
