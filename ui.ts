/**
 * ui.ts — the extension's only command `/template` and the status line.
 *
 * Menu (pi-tui, like the old roles extension): session context status,
 * variable values (computed ones with value age), changing overridable
 * variables, recomputing the given computed variable, recomputing all, the
 * "update current session context" button (`apply()`) and the "rewrite
 * files on disk" button.
 *
 * A variable change writes a `"var"` record (payload `{name, value}`) and
 * does not apply the context — only marks it stale. The status line is a
 * single `template` key: one glyph for the state plus the pair of the
 * variable named by the top-level `statusVariable`. The `ctrl+r`/`alt+r`
 * shortcuts cycle the value of that variable (a session override, no apply)
 * and the variable itself (written into `template.json`).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TemplateSession } from "./session.ts";
import {
	type MenuItem,
	type VariableFacts,
	changeVariable,
	contextStatusMark,
	formatAge,
	menuRowSegments,
	menuRowText,
	menuItems,
	variableStatusMark,
	nextStatusVariable,
	nextVariableValue,
	statusLineText,
	statusVariableChoices,
	variableFacts,
} from "./ui-model.ts";

/** Status line key — the extension's single indicator. */
const STATUS_KEY = "template";
const COMMAND_NAME = "template";

/** Data from the `index.ts` session map needed by the command and status. */
export interface TemplateUiDeps {
	/** Session instance from the map; no session — undefined. */
	sessionOf(ctx: ExtensionContext): TemplateSession | undefined;
	/** Live session override map: written on a variable change. */
	overridesOf(ctx: ExtensionContext): Record<string, string>;
}

/** Register the `/template` command; the extension provides no other commands. */
export function registerTemplateCommand(pi: ExtensionAPI, deps: TemplateUiDeps): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Manage pi-template context",
		handler: async (_args, ctx) => {
			await runTemplateCommand(pi, deps, ctx);
		},
	});
}

/** Status line: one state glyph and the status variable pair. */
export function updateTemplateStatus(ctx: ExtensionContext, session: TemplateSession | undefined): void {
	try {
		if (session === undefined) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (!session.ready()) {
			ctx.ui.setStatus(STATUS_KEY, statusLineText(undefined, undefined, {}));
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, statusLineText(session.isStale(), session.statusVariable(), session.currentView()));
	} catch {
		// The context was replaced or the UI is gone: the status is not critical.
	}
}

/**
 * `ctrl+r`: the next value of the status variable as a session override. The
 * context is not applied — only marked stale; a variable without a value
 * list does nothing. Shortcuts are dispatched by the interactive mode only,
 * so outside it (RPC/headless) the call does nothing.
 */
export async function cycleStatusVariableValue(
	pi: ExtensionAPI,
	deps: TemplateUiDeps,
	ctx: ExtensionContext,
): Promise<void> {
	if (ctx.mode !== "tui") return;
	const session = deps.sessionOf(ctx);
	if (session === undefined || !session.ready()) return;
	const name = session.statusVariable();
	if (name === undefined) return;
	const values = session.currentValues()[name];
	if (values === undefined || values.length === 0) return;
	const value = nextVariableValue(values, session.currentView()[name]);
	if (value === undefined) return;
	const overrides = deps.overridesOf(ctx);
	const result = await changeVariable(session, (customType, data) => pi.appendEntry(customType, data), name, value);
	if (!result.ok) {
		ctx.ui.notify(`pi-template: ${name} not changed — ${result.problem ?? "unknown reason"}`, "warning");
		return;
	}
	if (result.written) overrides[name] = value;
	updateTemplateStatus(ctx, session);
	ctx.ui.notify(
		result.written ? `pi-template: ${name} = ${value}` : `pi-template: ${name} = ${value} — already set`,
		"info",
	);
}

/**
 * `alt+r`: the next status variable of the ring, written into `template.json`.
 * Outside the interactive mode (RPC/headless) the call does nothing.
 */
export function cycleStatusVariable(deps: TemplateUiDeps, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	const session = deps.sessionOf(ctx);
	if (session === undefined || !session.ready()) return;
	const next = nextStatusVariable(statusVariableChoices(session.currentValues()), session.statusVariable());
	if (next === undefined) {
		ctx.ui.notify("pi-template: no variable with a values list", "warning");
		return;
	}
	const saved = session.saveStatusVariable(next);
	if (!saved.ok) {
		ctx.ui.notify(`pi-template: status variable not changed — ${saved.problem ?? "unknown reason"}`, "warning");
		return;
	}
	updateTemplateStatus(ctx, session);
	ctx.ui.notify(`pi-template: status variable = ${next}`, "info");
}

/** Clear the status (session runtime shutdown). */
export function clearTemplateStatus(ctx: ExtensionContext): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	} catch {
		// The UI is gone — nothing to clear.
	}
}

async function runTemplateCommand(pi: ExtensionAPI, deps: TemplateUiDeps, ctx: ExtensionCommandContext): Promise<void> {
	const session = deps.sessionOf(ctx);
	if (session === undefined) {
		ctx.ui.notify("pi-template: no session found — the command works inside an active pi session", "warning");
		return;
	}
	const overrides = deps.overridesOf(ctx);
	if (!session.ready()) {
		const problems = session.sessionProblems();
		const details = problems.length > 0 ? `: ${problems.join("; ")}` : "";
		ctx.ui.notify(`pi-template: context not built${details}`, "warning");
		return;
	}
	try {
		// Menu construction and all actions share one catch: a UI/session failure
		// must not bring the command down.
		await runMenuUntilExit(pi, ctx, session, overrides);
	} catch (error) {
		try {
			ctx.ui.notify(`pi-template: command failed — ${errorMessage(error)}`, "warning");
		} catch {
			// The context was already replaced (e.g. reload) — no one to notify.
		}
	}
}

/**
 * Menu until full exit: Esc in a value dialog goes back to the menu, full
 * close only from the menu root (or after a reload).
 */
async function runMenuUntilExit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: TemplateSession,
	overrides: Record<string, string>,
): Promise<void> {
	let cursor = 0;
	for (;;) {
		const items = menuItems(variableFacts(session, overrides));
		const choice = await chooseMenuItem(ctx, session, items, cursor);
		if (choice === undefined) return; // Esc in the menu root — close
		cursor = choice.index;
		const outcome = await performMenuItem(pi, ctx, session, overrides, choice.item);
		if (outcome === "cancelled") continue; // Esc in a value dialog — back to the menu
		return;
	}
}

/** Item outcome: `cancelled` means Esc in a value dialog (step back). */
type MenuOutcome = "done" | "cancelled";

/** Chosen item and position (the position is the cursor when returning to the menu). */
interface MenuChoice {
	item: MenuItem;
	index: number;
}

/** Choose an item: pi-tui menu in TUI, dialogs in other UI modes. */
async function chooseMenuItem(
	ctx: ExtensionCommandContext,
	session: TemplateSession,
	items: readonly MenuItem[],
	cursor: number,
): Promise<MenuChoice | undefined> {
	if (ctx.mode === "tui") return chooseMenuItemInMenu(ctx, session, items, cursor);
	if (!ctx.hasUI) {
		ctx.ui.notify(menuDigest(session, items), "info");
		return undefined;
	}
	const labels = items.map((item) => menuRowText(item));
	// Implicit `model`/`level` are shown read-only here too: the menu title and
	const title = menuTitle(session);
	const chosen = await ctx.ui.select(title, labels);
	if (chosen === undefined) return undefined;
	const index = labels.indexOf(chosen);
	return index === -1 ? undefined : { item: items[index], index };
}

/** Menu with ↑/↓ navigation, Enter to select, Esc to go back/close. */
function chooseMenuItemInMenu(
	ctx: ExtensionCommandContext,
	session: TemplateSession,
	items: readonly MenuItem[],
	cursor: number,
): Promise<MenuChoice | undefined> {
	return ctx.ui.custom<MenuChoice | undefined>((tui, theme, _keybindings, done) => {
		let index = Math.min(Math.max(cursor, 0), items.length - 1);
		let cached: string[] | undefined;
		const refresh = (): void => {
			cached = undefined;
			tui.requestRender();
		};
		const handleInput = (data: string): void => {
			if (matchesKey(data, Key.up)) {
				index = (index - 1 + items.length) % items.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				index = (index + 1) % items.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
				done({ item: items[index], index });
				return;
			}
			if (matchesKey(data, Key.escape)) done(undefined);
		};
		const render = (width: number): string[] => {
			if (cached !== undefined) return cached;
			cached = renderMenu(theme, session, items, index, width);
			return cached;
		};
		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});
}

function renderMenu(
	theme: Theme,
	session: TemplateSession,
	items: readonly MenuItem[],
	index: number,
	width: number,
): string[] {
	const renderWidth = Math.max(1, width);
	const stale = session.isStale();
	const lines = [theme.fg("accent", "─".repeat(renderWidth))];
	const statusColor: ThemeColor = stale === undefined ? "error" : stale ? "warning" : "success";
	lines.push(
		truncateToWidth(
			`${theme.fg("accent", " template — session context")} ${theme.fg(statusColor, contextStatusMark(stale))}`,
			renderWidth,
		),
	);
	lines.push("");
	items.forEach((item, row) => {
		const pointer = row === index ? theme.fg("accent", "> ") : "  ";
		const color: ThemeColor = item.action === "recompute" || item.action === "implicit" ? "muted" : "text";
		const segments = menuRowSegments(item).map((segment) =>
			segment.kind === "status"
				? theme.fg(segment.changed ? "warning" : "success", variableStatusMark(segment.changed))
				: segment.text,
		);
		lines.push(truncateToWidth(`${pointer}${theme.fg(color, segments.join(" · "))}`, renderWidth));
	});
	lines.push("");
	lines.push(
		truncateToWidth(
			theme.fg("dim", " ↑↓ — navigate • Enter — select • Esc — back/close"),
			renderWidth,
		),
	);
	lines.push(theme.fg("accent", "─".repeat(renderWidth)));
	return lines;
}

/** Perform the chosen item. */
async function performMenuItem(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: TemplateSession,
	overrides: Record<string, string>,
	item: MenuItem,
): Promise<MenuOutcome> {
	if (item.action === "rewriteFiles") {
		// The button rewrites files only: apply and reload are not its business;
		// versions, applied context and session records are not touched.
		if (session.rewriteFiles()) {
			ctx.ui.notify("pi-template: targets rewritten", "info");
		} else {
			ctx.ui.notify("pi-template: nothing to rewrite", "warning");
		}
		return "done";
	}
	if (item.action === "apply") {
		const applied = session.apply();
		updateTemplateStatus(ctx, session);
		ctx.ui.notify(
			applied ? "pi-template: context updated — delivery on the next turn" : "pi-template: nothing to apply",
			applied ? "info" : "warning",
		);
		return "done";
	}
	if (item.action === "recomputeAll") {
		const result = await session.recomputeAll();
		updateTemplateStatus(ctx, session);
		ctx.ui.notify(
			result.ok
				? "pi-template: variables recomputed"
				: `pi-template: recompute failed — ${result.problem ?? "unknown reason"}`,
			result.ok ? "info" : "warning",
		);
		return "done";
	}
	if (item.action === "implicit") {
		ctx.ui.notify("pi-template: model and level change through pi's own controls — read-only here", "info");
		return "cancelled";
	}
	const facts = item.facts;
	if (facts === undefined) return "done";
	if (item.action === "recompute") {
		await recomputeVariable(ctx, session, facts.name);
		return "done";
	}
	return changeSessionVariable(pi, ctx, session, overrides, facts);
}

/** Recompute the given shell/env variable; the context is not applied. */
async function recomputeVariable(ctx: ExtensionCommandContext, session: TemplateSession, name: string): Promise<void> {
	const result = await session.recompute(name);
	updateTemplateStatus(ctx, session);
	if (!result.ok) {
		ctx.ui.notify(`pi-template: ${name} not recomputed — ${result.problem ?? "unknown reason"}`, "warning");
		return;
	}
	const value = session.currentView()[name];
	const age = session.computedAge(name);
	ctx.ui.notify(`pi-template: ${name} = ${value ?? "—"}${age === undefined ? "" : ` · ${formatAge(age)}`}`, "info");
}

/** Change a session variable: a `"var"` record, without applying the context. */
async function changeSessionVariable(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: TemplateSession,
	overrides: Record<string, string>,
	facts: VariableFacts,
): Promise<MenuOutcome> {
	const value = await chooseValue(ctx, facts);
	if (value === undefined) return "cancelled"; // Esc — back to the menu
	const result = await changeVariable(
		session,
		(customType, data) => pi.appendEntry(customType, data),
		facts.name,
		value,
	);
	if (!result.ok) {
		ctx.ui.notify(`pi-template: ${facts.name} not changed — ${result.problem ?? "unknown reason"}`, "warning");
		return "done";
	}
	if (result.written) overrides[facts.name] = value;
	updateTemplateStatus(ctx, session);
	if (!result.written) {
		ctx.ui.notify(`pi-template: ${facts.name} = ${value} — already set`, "info");
		return "done";
	}
	ctx.ui.notify(`pi-template: ${facts.name} = ${value} — ${contextStatusMark(session.isStale())}`, "info");
	return "done";
}

/** Variable value: a config list or a line input. */
async function chooseValue(ctx: ExtensionCommandContext, facts: VariableFacts): Promise<string | undefined> {
	const options = facts.values ?? [];
	if (options.length === 0) return ctx.ui.input(`Value for ${facts.name}`, facts.value ?? "");
	const labels = options.map((value) => (value === facts.value ? `${value} (current)` : value));
	const chosen = await ctx.ui.select(`Variable ${facts.name}`, labels);
	if (chosen === undefined) return undefined;
	const index = labels.indexOf(chosen);
	return index === -1 ? undefined : options[index];
}

function menuTitle(session: TemplateSession): string {
	return `pi-template · ${contextStatusMark(session.isStale())}`;
}

/** Without UI: state and menu items as text, nothing changes. */
function menuDigest(session: TemplateSession, items: readonly MenuItem[]): string {
	const lines = [menuTitle(session)];
	for (const item of items) lines.push(`  ${menuRowText(item)}`);
	lines.push("UI unavailable — nothing changed");
	return lines.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
