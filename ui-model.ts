/**
 * ui-model.ts — data and rules of the `/template` menu without pi imports:
 * session records `"var"` (writing and reading the last value), variable
 * facts, selecting overridable variables, menu row labels, computed value
 * age, the status line and the quick-switch rings (`ctrl+r`/`alt+r`). The
 * module is checked by probe.mjs.
 *
 * Records: `"var"` is the only record the extension writes, payload
 * strictly `{name, value}`; old-format records (`customType: "role"`) and
 * other `customType`s are not read.
 */

import { IMPLICIT_VARIABLE_NAMES } from "./vars.ts";

/** Session record payload for `"var"` — strictly `{name, value}`. */
export interface VarEntry {
	name: string;
	value: string;
}

/** A new `"var"` record: the payload has no other fields. */
export function varEntry(name: string, value: string): VarEntry {
	return { name, value };
}

/**
 * The last value of each variable from its `"var"` records — above the
 * machine `initial` at session start (resume). Only `type: "custom"` with
 * `customType: "var"` and a string `name`/`value` pair are read; `"role"`
 * and other records are ignored.
 */
export function readVarOverrides(entries: readonly unknown[]): Record<string, string> {
	const overrides: Record<string, string> = {};
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type !== "custom" || entry.customType !== "var") continue;
		const data = entry.data;
		if (!isRecord(data)) continue;
		if (typeof data.name !== "string" || typeof data.value !== "string") continue;
		overrides[data.name] = data.value;
	}
	return overrides;
}

/** Menu data source — `TemplateSession` methods (structural type). */
export interface MenuSession {
	currentView(): Record<string, string>;
	appliedView(): Record<string, string>;
	currentValues(): Record<string, string[] | undefined>;
	computedAge(name: string): number | undefined;
}

/** Facts of a declared variable for the menu and the status line. */
export interface VariableFacts {
	/** Variable name. */
	name: string;
	/** Effective view value; an empty string means no value. */
	value: string | undefined;
	/** Allowed values from the config, when a list is declared. */
	values: readonly string[] | undefined;
	/** The value is computed by a shell/env command (read-only, has an age). */
	computed: boolean;
	/** Age of the computed value, ms. */
	ageMs: number | undefined;
	/** A session override is in effect. */
	overridden: boolean;
	/** Implicit variable (`model`/`level`). */
	implicit: boolean;
	/** The value differs from the applied context: the variable changed without applying. */
	changed: boolean;
}

/**
 * Variable facts in declaration order. Age exists only for computed values
 * (shell/env `initial`) — it is also the computed marker; an override
 * applies only to non-computed and non-implicit variables.
 */
export function variableFacts(session: MenuSession, overrides: Readonly<Record<string, string>>): VariableFacts[] {
	const view = session.currentView();
	const applied = session.appliedView();
	const values = session.currentValues();
	return Object.keys(values).map((name) => {
		const ageMs = session.computedAge(name);
		const computed = ageMs !== undefined;
		const implicit = isImplicit(name);
		return {
			name,
			value: view[name],
			values: values[name],
			computed,
			ageMs,
			overridden: !computed && !implicit && Object.hasOwn(overrides, name),
			implicit,
			changed: applied[name] !== view[name],
		};
	});
}

/** Menu item action. */
export type MenuAction = "change" | "recompute" | "recomputeAll" | "apply" | "rewriteFiles";

/** Menu item. */
export interface MenuItem {
	action: MenuAction;
	/** Item variable — for the `change` and `recompute` actions. */
	facts?: VariableFacts;
}

/**
 * Menu items: overridable variables (change value), computed ones (recompute
 * the given one), recompute all, apply and rewrite files on disk. Computed
 * and implicit variables are not offered for change, implicit ones are not
 * shown at all.
 */
export function menuItems(facts: readonly VariableFacts[]): MenuItem[] {
	const items: MenuItem[] = [];
	for (const fact of facts) {
		if (fact.implicit) continue;
		items.push(fact.computed ? { action: "recompute", facts: fact } : { action: "change", facts: fact });
	}
	items.push({ action: "recomputeAll" }, { action: "apply" }, { action: "rewriteFiles" });
	return items;
}

/** Menu row segment: row text or the status mark the UI colors on its own. */
export type MenuRowSegment = { kind: "text"; text: string } | { kind: "status"; changed: boolean };

/** Menu row: the name and value, the status mark, then the markers. */
export function menuRowSegments(item: MenuItem): MenuRowSegment[] {
	if (item.action === "recomputeAll") return [{ kind: "text", text: "recompute all variables" }];
	if (item.action === "apply") return [{ kind: "text", text: "update current session context" }];
	if (item.action === "rewriteFiles") return [{ kind: "text", text: "rewrite files on disk" }];
	const fact = item.facts;
	if (fact === undefined) return [];
	const value = fact.value === undefined || fact.value === "" ? "—" : fact.value;
	const segments: MenuRowSegment[] = [
		{ kind: "text", text: `${fact.name} = ${value}` },
		{ kind: "status", changed: fact.changed },
	];
	if (fact.computed) segments.push({ kind: "text", text: `computed, ${formatAge(fact.ageMs ?? 0)} — Enter: recompute` });
	else if (fact.overridden) segments.push({ kind: "text", text: "session override" });
	return segments;
}

/** Variable status glyph: `✓` applied, `!` changed without applying. */
export function variableStatusMark(changed: boolean): string {
	return changed ? "!" : "✓";
}

/** Menu row as plain text: labels, digest, tests. */
export function menuRowText(item: MenuItem): string {
	return menuRowSegments(item)
		.map((segment) => (segment.kind === "status" ? variableStatusMark(segment.changed) : segment.text))
		.join(" · ");
}

/** Computed value age, compact: seconds, minutes, hours, days. */
export function formatAge(ageMs: number): string {
	const seconds = Math.max(0, Math.floor(ageMs / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h`;
	return `${Math.floor(hours / 24)} d`;
}

/** Session context status glyph: `✓` applied, `!` a re-render is waiting, `‼` no view. */
export function contextStatusMark(stale: boolean | undefined): string {
	return stale === undefined ? "‼" : stale ? "!" : "✓";
}

/** Implicit variable row: session `model`/`level`, read-only. */
export function implicitLine(view: Record<string, string>): string {
	return `model = ${view.model ?? "—"} · level = ${view.level ?? "—"} (implicit, read-only)`;
}

/**
 * Status line text: `template <glyph>` plus the status variable pair
 * (`name=value`, the value compacted). The variable is the top-level
 * `statusVariable`; without it the line is just the glyph. `stale ===
 * undefined` means no view was built (a broken config).
 */
export function statusLineText(
	stale: boolean | undefined,
	statusVariable: string | undefined,
	view: Readonly<Record<string, string>>,
): string {
	const base = `template ${contextStatusMark(stale)}`;
	if (statusVariable === undefined) return base;
	return `${base} ${statusVariable}=${shortValue(view[statusVariable])}`;
}

/**
 * Variables the status line can show: declared ones with a non-empty value
 * list, in declaration order.
 */
export function statusVariableChoices(values: Readonly<Record<string, string[] | undefined>>): string[] {
	const choices: string[] = [];
	for (const [name, list] of Object.entries(values)) {
		if (list !== undefined && list.length > 0) choices.push(name);
	}
	return choices;
}

/**
 * Next status variable of the ring: after `current`; the first one when
 * `current` is not among the choices. `undefined` — nothing to switch to.
 */
export function nextStatusVariable(choices: readonly string[], current: string | undefined): string | undefined {
	if (choices.length === 0) return undefined;
	const at = current === undefined ? -1 : choices.indexOf(current);
	return choices[(at + 1) % choices.length];
}

/**
 * Next value of the ring: after `current`; the first one when `current` is
 * not in the list. `undefined` — the list is empty.
 */
export function nextVariableValue(values: readonly string[], current: string | undefined): string | undefined {
	if (values.length === 0) return undefined;
	const at = current === undefined ? -1 : values.indexOf(current);
	return values[(at + 1) % values.length];
}

/** Minimum session for changing a variable (structural type of `TemplateSession`). */
export interface VariableChangeSession {
	currentView(): Record<string, string>;
	setVariable(name: string, value: string): Promise<{ ok: boolean; problem?: string }>;
}

/** Result of a session variable change. */
export interface VariableChangeResult {
	ok: boolean;
	/** A `"var"` record was written: the value really changed. */
	written: boolean;
	problem?: string;
}

/**
 * Change a session variable: a value equal to the effective one changes
 * nothing; otherwise `setVariable` and a `"var"` record with the payload
 * `{name, value}`. The context is not applied — only marked stale.
 */
export async function changeVariable(
	session: VariableChangeSession,
	writeEntry: (customType: "var", data: VarEntry) => void,
	name: string,
	value: string,
): Promise<VariableChangeResult> {
	if (session.currentView()[name] === value) return { ok: true, written: false };
	const result = await session.setVariable(name, value);
	if (!result.ok) return { ok: false, written: false, problem: result.problem };
	writeEntry("var", varEntry(name, value));
	return { ok: true, written: true };
}

const SHORT_VALUE_LIMIT = 16;

function shortValue(value: string | undefined): string {
	const text = value === undefined || value === "" ? "—" : value;
	return text.length <= SHORT_VALUE_LIMIT ? text : `${text.slice(0, SHORT_VALUE_LIMIT - 1)}…`;
}

function isImplicit(name: string): boolean {
	return (IMPLICIT_VARIABLE_NAMES as readonly string[]).includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
