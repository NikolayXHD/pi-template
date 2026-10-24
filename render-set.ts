/**
 * Render a set of sources into target files.
 *
 * Pipeline: each source is linted (warnings are collected, problems fail
 * the file) and rendered — include names are resolved on disk at render
 * time, include texts are read and linted when they are included. Template
 * files are linted by their own rules (`@` qualifier, partials, literals);
 * rendered text with frontmatter is validated by YAML parsing. A file
 * failure leaves the target file not rewritten: the version keeps the
 * previous successful text (the last-success cache), and the problem names
 * the source and the reason.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { type AgentFilePreliminary, type HeaderParser, renderAgentFile } from "./agent.ts";
import { type PartialResolver, lintTemplate, renderTemplate } from "./render.ts";
import type { TemplateSource } from "./sources.ts";

/** Future subagent view for the two-stage agent file render. */
export interface SubagentRenderView {
	parentView: Record<string, string>;
	subagentView: Record<string, string>;
	preliminary: AgentFilePreliminary;
}

export interface RenderSetContext {
	/** Session variable values: regular references. */
	view: Record<string, string>;
	variables: Record<string, string[] | undefined>;
	/** Include resolver: names are resolved on disk at render time. */
	partials: PartialResolver;
	parseHeader: HeaderParser;
	/** Future subagent view — by agent name (two-stage render). */
	subagentView: (agentName: string) => Promise<SubagentRenderView> | SubagentRenderView;
}

export interface RenderReport {
	/** Target file texts: absolute target path → text (on failures — the previous success). */
	texts: Record<string, string>;
	problems: string[];
	/** Render failures per file — the report of the rewrite button. */
	failures: RenderFailure[];
	warnings: string[];
}

/** Render failure of one source: the target keeps the previous successful text. */
export interface RenderFailure {
	/** Absolute path of the source. */
	source: string;
	/** Absolute path of the target. */
	target: string;
	problem: string;
}

/** Agent name of the file — the base name of the target file without the `.md` extension. */
export function agentNameOf(targetPath: string): string {
	return basename(targetPath).replace(/\.md$/u, "");
}

/**
 * Rendered `.md` file text with frontmatter is validated by YAML parsing:
 * skill descriptions and agent headers live in frontmatter. Without `---`
 * delimiters there is nothing to validate.
 */
function validateFrontmatter(text: string, parseHeader: HeaderParser): void {
	if (!text.startsWith("---")) return;
	parseHeader(text);
}

export async function renderSources(
	sources: readonly TemplateSource[],
	context: RenderSetContext,
	previousText: (target: string) => string | undefined,
): Promise<RenderReport> {
	const texts: Record<string, string> = {};
	const problems: string[] = [];
	const failures: RenderFailure[] = [];
	const warnings: string[] = [];

	for (const source of [...sources].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))) {
		let text: string | undefined;
		try {
			text = await renderSource(source, context, warnings);
		} catch (error) {
			const problem = errorMessage(error);
			problems.push(`${source.source}: ${problem}`);
			failures.push({ source: source.source, target: source.target, problem });
		}
		if (text === undefined) {
			const previous = previousText(source.target);
			if (previous !== undefined) texts[source.target] = previous;
			continue;
		}
		texts[source.target] = text;
	}
	return { texts, problems, failures, warnings };
}

/**
 * Render one source: the source text is linted up front (warnings go to the
 * collector, a problem is thrown), then the engine renders it and reads the
 * includes it needs.
 */
export async function renderSource(
	source: TemplateSource,
	context: RenderSetContext,
	warnings: string[] = [],
): Promise<string> {
	let sourceText: string;
	try {
		sourceText = readFileSync(source.source, "utf-8");
	} catch (error) {
		throw new Error(`source cannot be read: ${errorMessage(error)}`);
	}

	const agentName = source.kind === "agent" ? agentNameOf(source.target) : undefined;
	const lint = lintTemplate(sourceText, {
		variables: context.variables,
		partials: context.partials,
		agentName,
	});
	if (lint.problem !== null) throw new Error(`lint: ${lint.problem}`);
	for (const warning of lint.warnings) warnings.push(`${source.source}: ${warning}`);

	if (agentName === undefined) {
		const rendered = renderTemplate(sourceText, {
			view: context.view,
			variables: context.variables,
			partials: context.partials,
			warnings,
		});
		validateFrontmatter(rendered, context.parseHeader);
		return rendered;
	}

	const subagent = await context.subagentView(agentName);
	const rendered = renderAgentFile(sourceText, {
		agentName,
		parentView: subagent.parentView,
		subagentView: subagent.subagentView,
		variables: context.variables,
		partials: context.partials,
		preliminary: subagent.preliminary,
		parseHeader: context.parseHeader,
		warnings,
	});
	return rendered.text;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
