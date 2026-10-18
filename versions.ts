/**
 * Versions of the set of files affecting the session context.
 *
 * Two versions live in memory: the applied one — the one in the prompt and
 * on disk in the target files — and the current one, re-rendered from fresh
 * sources and values. Only the current one changes by itself; the mismatch
 * between versions is "prompts are stale". Freshness is checked by source
 * `mtime`+`size`: editing a source re-renders the current version and marks
 * the context stale, the prompt does not change.
 */

import { statSync } from "node:fs";
import { canonicalJson } from "./vars.ts";

export interface ContextVersion {
	/** Target file texts: absolute target path → rendered text. */
	texts: Record<string, string>;
	/** View values the version was rendered under. */
	view: Record<string, string>;
}

/** File stamp: `mtimeMs:size`; no file — an empty string. */
export function fileStamp(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "";
	}
}

/** Stamps of a path set: a removed/added file changes the key set. */
export function sourceStamps(paths: readonly string[]): Record<string, string> {
	const stamps: Record<string, string> = {};
	for (const path of [...paths].sort()) stamps[path] = fileStamp(path);
	return stamps;
}

/** Stamp comparison: a value or path-set mismatch means the source changed. */
export function stampsDiffer(
	before: Readonly<Record<string, string>>,
	after: Readonly<Record<string, string>>,
): boolean {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		if (before[key] !== after[key]) return true;
	}
	return false;
}

/** Applied and current version pair: versions match after applying. */
export class ContextVersions {
	private appliedVersion: ContextVersion | null = null;
	private currentVersion: ContextVersion | null = null;

	get applied(): ContextVersion | null {
		return this.appliedVersion;
	}

	get current(): ContextVersion | null {
		return this.currentVersion;
	}

	setCurrent(version: ContextVersion): void {
		this.currentVersion = version;
	}

	setApplied(version: ContextVersion): void {
		this.appliedVersion = version;
	}

	/** Apply: the applied version becomes the current one. */
	applyCurrent(): void {
		if (this.currentVersion === null) return;
		this.appliedVersion = this.currentVersion;
	}

	/**
	 * Version mismatch — "prompts are stale". The texts and the view: a model or
	 * level change re-renders the current version under the new values, and the
	 * context is stale even when the texts happen to coincide.
	 */
	stale(): boolean {
		if (this.appliedVersion === null || this.currentVersion === null) {
			return this.appliedVersion !== this.currentVersion;
		}
		if (canonicalJson(this.appliedVersion.texts) !== canonicalJson(this.currentVersion.texts)) return true;
		return canonicalJson(this.appliedVersion.view) !== canonicalJson(this.currentVersion.view);
	}
}
