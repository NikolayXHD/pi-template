/**
 * Grammar, lint, partials and template render.
 *
 * The vocabulary is deliberately narrow: `if`/`unless` blocks over
 * conditions (the expression grammar of expr.ts: `eq`/`in` over a variable
 * and string literals, `and`/`or`/`not` over subexpressions, a bare name —
 * a boolean variable); interpolation `{{v}}` of declared variables;
 * partials — static (`{{> roles/snippets/tests.md}}` — the name is a path
 * from the root) and dynamic (`{{> (concat "roles/" role ".md")}}` —
 * `concat` of literal segments and variables); comments. Everything else is
 * a lint error, not a silent render rejection.
 *
 * The `@` qualifier references a variable value at a subagent:
 * `{{[vllm@]}}` (any subagent) and `{{[vllm@foo]}}` (agent `foo`); legal
 * only in agent files (`agents/**`); other agent names in the file of
 * `foo` are an error. The notation is a Handlebars steno path: an
 * identifier does not allow `@`, so `{{vllm@}}` cannot be parsed and would
 * require rewriting tags with a pre-lexer. In an agent file header
 * `model@`/`level@` are legal: the header is rendered by iterations to a
 * fixpoint (see `renderAgentHeader`); if a model or level expression does
 * not converge, it is a render error.
 *
 * Lint checks include existence on disk (a static name; a dynamic one for
 * every variable value from the known list — a missing dynamic value is a
 * warning). An include text passes the same lint when it is read, without
 * an agent identity (an `@` qualifier in an include is an error): a
 * vocabulary violation there fails the includer. A literal outside the
 * variable value list and a level outside the thinking level set are a
 * warning (the list may be outdated). A bare name condition is legal for a
 * boolean variable (values `true`/`false`) and means `eq name "true"`.
 * Frontmatter is rendered alongside the body.
 *
 * Render runs in its own environment: `knownHelpersOnly`, `noEscape: true`,
 * `knownHelpers` — `eq` (strict comparison), `in`, `and`, `or`, `not`,
 * `concat`, `if`, `unless`. A missing include at render time is an
 * exception, not silent emptiness.
 *
 * An agent file is rendered in two stages (the seam for subagent spawn):
 * `renderAgentHeader` — the header iterated to a fixpoint (regular
 * references use the parent session view, `@` references the subagent
 * values; actual `model`/`level` are extracted by a caller callback — YAML
 * parsing is outside the engine), then `renderAgentBody` — the body
 * (regular references use the parent view, `@` references the full future
 * child view with actual `model@`/`level@`).
 */

import Handlebars from "handlebars";
import { exprAtoms, exprFromHbs, isExprProblem, isTruthy, literalWarnings } from "./expr.ts";
import type { ExprAtom } from "./expr.ts";
import { IMPLICIT_VARIABLE_NAMES, isAgentName } from "./vars.ts";

export { THINKING_LEVELS } from "./expr.ts";

const BLOCK_HELPERS = ["if", "unless"] as const;

export interface LintContext {
	/** Variable name → known value list; `undefined` — no list. */
	variables: Record<string, string[] | undefined>;
	/** Include resolver: existence checks against the disk. */
	partials: PartialResolver;
	/** Agent name — lint of an agent file (`agents/**`); undefined outside them. */
	agentName?: string;
}

/**
 * Include source on disk: the name is a path from the root — the agent
 * directory without a prefix, the project root with the `.pi/` prefix. The
 * text is read at render time (the implementation caches per pass), so files
 * that are not included are not read; `exists` is the lint-time check.
 */
export interface PartialResolver {
	/** Whether `X.template` or `X` exists for the include name. */
	exists(name: string): boolean;
	/** Include text: from `X.template` when present, otherwise from `X`. */
	read(name: string): string | undefined;
}

/** Internal lint input: only the presence of an include name matters. */
interface LintInput {
	variables: Record<string, string[] | undefined>;
	partials: PartialResolver;
	agentName?: string;
}

export interface LintResult {
	problem: string | null;
	warnings: string[];
}

export function lintTemplate(source: string, context: LintContext): LintResult {
	const input: LintInput = {
		variables: context.variables,
		partials: context.partials,
		agentName: context.agentName,
	};
	if (input.agentName === undefined) return lintPart(source, input);
	// The header and the body are rendered in separate passes — and parsed
	// separately: a block opened in one and closed in the other is an error,
	const { header, body } = splitAgentSource(source);
	const headerResult = lintPart(header, input);
	if (headerResult.problem !== null) return headerResult;
	const bodyResult = lintPart(body, input);
	return { problem: bodyResult.problem, warnings: [...headerResult.warnings, ...bodyResult.warnings] };
}

export interface RenderContext {
	/** Session variable values: regular references. */
	view: Record<string, string>;
	variables: Record<string, string[] | undefined>;
	/** Include resolver: names are resolved on disk at render time. */
	partials: PartialResolver;
	/** Collector of lint warnings of the include texts read in this pass. */
	warnings?: string[];
}

export interface AgentRenderContext {
	/** Agent name — the target of `@` references. */
	agentName: string;
	/** Parent session variable values — regular references. */
	parentView: Record<string, string>;
	/** Full future child view — the values of `@` references. */
	subagentView: Record<string, string>;
	variables: Record<string, string[] | undefined>;
	/** Include resolver: names are resolved on disk at render time. */
	partials: PartialResolver;
	/** Collector of lint warnings of the include texts read in this pass. */
	warnings?: string[];
}

/** Render a regular source: regular references use the session view. */
export function renderTemplate(source: string, context: RenderContext): string {
	const input: LintInput = { variables: context.variables, partials: context.partials };
	const problem = lintPart(source, input).problem;
	if (problem !== null) throw new Error(`lint: ${problem}`);
	return renderLinted(source, context.view, input, context.warnings);
}

/**
 * Actual `model`/`level` from the rendered header. YAML parsing is outside
 * the engine; the callback is a pure function of text, a parse failure is
 * the caller's exception (the file render has failed).
 */
export type AgentHeaderExtract = (header: string) => { model: string; level: string };

/** The header at its fixpoint and its actual `model`/`level` — stage 2 input. */
export interface AgentHeaderFixpoint {
	header: string;
	model: string;
	level: string;
}

/** Fixpoint pass limit — a safety net; a cycle is caught by a repeated pair. */
const HEADER_FIXPOINT_LIMIT = 100;

/**
 * Agent file stage 1: the header is rendered iterated to a fixpoint — a
 * pass with actual `model`/`level` that gives the same text. The first pass
 * uses preliminary values from `subagentView` (spawn parameters over the
 * session default); actual values are extracted by `extract`.
 * `model@`/`level@` in the header are legal; if the model or level
 * expression itself does not converge — a repeated `model`/`level` pair
 * with unstable text is a render error.
 */
export function renderAgentHeader(
	source: string,
	context: AgentRenderContext,
	extract: AgentHeaderExtract,
): AgentHeaderFixpoint {
	const { header } = splitAgentSource(source);
	const input = lintInput(context);
	const problem = lintPart(header, input).problem;
	if (problem !== null) throw new Error(`lint: ${problem}`);
	requireSubagentValues(header, context);

	let text = renderLinted(header, agentView(context), input, context.warnings);
	const seen = new Set<string>();
	for (let pass = 0; pass < HEADER_FIXPOINT_LIMIT; pass += 1) {
		const { model, level } = extract(text);
		const next = renderLinted(
			header,
			agentView({ ...context, subagentView: { ...context.subagentView, model, level } }),
			input,
			context.warnings,
		);
		// Fixpoint — the pass with actual values gave the same text.
		if (next === text) return { header: next, model, level };
		const pair = `${model}\u0000${level}`;
		if (seen.has(pair)) {
			throw new Error("header model depends on `model@` — state repeats across iterations");
		}
		seen.add(pair);
		text = next;
	}
	throw new Error(`agent file header does not reach a fixpoint: exceeded ${HEADER_FIXPOINT_LIMIT} passes`);
}

/** Agent file stage 2: render the body with the full future child view. */
export function renderAgentBody(source: string, context: AgentRenderContext): string {
	const { body } = splitAgentSource(source);
	const input = lintInput(context);
	const problem = lintPart(body, input).problem;
	if (problem !== null) throw new Error(`lint: ${problem}`);
	requireSubagentValues(body, context);
	return renderLinted(body, agentView(context), input, context.warnings);
}

function lintInput(context: AgentRenderContext): LintInput {
	return { variables: context.variables, partials: context.partials, agentName: context.agentName };
}

/**
 * The header is frontmatter in pi's convention: the text starts with `---`
 * and contains a closing `---` line. Before splitting, a BOM is stripped
 * and line endings are normalized (as in pi's convention). No convention —
 */
function splitAgentSource(source: string): { header: string; body: string } {
	const text = normalizeAgentText(source);
	if (!text.startsWith("---")) return { header: "", body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { header: "", body: text };
	return { header: text.slice(0, end + 4), body: text.slice(end + 4) };
}

/** BOM and line endings — as in pi's convention (stripBom + normalizeNewlines). */
function normalizeAgentText(source: string): string {
	const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
	return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Agent render view: regular names come from the parent view, `@`
 * references from the child view. The qualifier keeps the variable name in
 * the key (`vllm@`, `vllm@foo`), so a regular Handlebars lookup resolves it.
 */
function agentView(context: AgentRenderContext): Record<string, string> {
	const view: Record<string, string> = { ...context.parentView };
	for (const [name, value] of Object.entries(context.subagentView)) {
		view[`${name}@`] = value;
		view[`${name}@${context.agentName}`] = value;
	}
	return view;
}

/**
 * Every `@` reference requires a value in the child view: a missing one is
 * a caller error, not silent emptiness.
 */
function requireSubagentValues(source: string, context: AgentRenderContext): void {
	for (const name of collectQualifiedNames(source)) {
		if (!Object.hasOwn(context.subagentView, name)) {
			throw new Error(`subagent value for variable "${name}" is not set — @ reference cannot resolve`);
		}
	}
}

/** Variable names in `@` references of the source. */
function collectQualifiedNames(source: string): string[] {
	const names: string[] = [];
	const addPath = (path: hbs.AST.PathExpression): void => {
		if (path.data || path.depth !== 0 || path.parts.length !== 1) return;
		const reference = parseReference(path.parts[0]);
		if ("problem" in reference || reference.agent === null) return;
		names.push(reference.name);
	};
	const addExpression = (expression: hbs.AST.Expression): void => {
		if (expression.type === "PathExpression") {
			addPath(expression as hbs.AST.PathExpression);
		} else if (expression.type === "SubExpression") {
			for (const param of (expression as hbs.AST.SubExpression).params) addExpression(param);
		}
	};
	const walk = (body: hbs.AST.Node[]): void => {
		for (const node of body) {
			if (node.type === "MustacheStatement") {
				addExpression((node as hbs.AST.MustacheStatement).path);
			} else if (node.type === "PartialStatement") {
				addExpression((node as hbs.AST.PartialStatement).name);
			} else if (node.type === "BlockStatement") {
				const block = node as hbs.AST.BlockStatement;
				for (const param of block.params) addExpression(param);
				walk(block.program.body);
				if (block.inverse !== undefined) walk(block.inverse.body);
			}
		}
	};
	let program: hbs.AST.Program;
	try {
		program = Handlebars.parse(source);
	} catch (error) {
		// Called after a successful lint; we do not swallow the error — a parse
		// failure must be visible, not turn into a skipped check.
		throw new Error(parseProblem(source, error));
	}
	walk(program.body);
	return names;
}

type LintIssues = { errors: string[]; warnings: string[] };

function lintPart(source: string, context: LintInput): LintResult {
	let program: hbs.AST.Program;
	try {
		program = Handlebars.parse(source);
	} catch (error) {
		return { problem: parseProblem(source, error), warnings: [] };
	}

	const issues: LintIssues = { errors: [], warnings: [] };
	for (const statement of program.body) {
		visit(statement, context, issues);
	}
	return { problem: issues.errors[0] ?? null, warnings: issues.warnings };
}

function parseProblem(source: string, error: unknown): string {
	const message = `template does not parse: ${errorMessage(error)}`;
	return hasRawQualifier(source)
		? `${message}; hint: the "@" qualifier uses the steno path form — [vllm@] or [vllm@foo]`
		: message;
}

/** Whether a tag has a `vllm@`/`vllm@foo` notation Handlebars cannot parse. */
function hasRawQualifier(source: string): boolean {
	return /\{\{[^}]*[A-Za-z_][A-Za-z0-9_]*@/.test(source);
}

function visit(node: hbs.AST.Node, context: LintInput, issues: LintIssues): void {
	switch (node.type) {
		case "ContentStatement":
		case "CommentStatement":
			return;
		case "BlockStatement": {
			const block = node as hbs.AST.BlockStatement;
			lintBlock(block, context, issues);
			const blockPrograms: Array<hbs.AST.Program | undefined> = [block.program, block.inverse];
			for (const program of blockPrograms) {
				if (program === undefined) continue;
				for (const statement of program.body) visit(statement, context, issues);
			}
			return;
		}
		case "MustacheStatement":
			lintMustache(node as hbs.AST.MustacheStatement, context, issues);
			return;
		case "PartialStatement":
			lintPartial(node as hbs.AST.PartialStatement, context, issues);
			return;
		case "PartialBlockStatement":
			issues.errors.push("block {{#> }} is not allowed");
			return;
		default:
			issues.errors.push(`construct ${node.type} is not allowed`);
	}
}

/** The hbs parser omits empty hash/block params — we check defensively. */
function hasPairs(hash: hbs.AST.Hash | undefined): boolean {
	return hash !== undefined && hash.pairs.length > 0;
}

function hasStrip(node: {
	strip?: hbs.AST.StripFlags;
	openStrip?: hbs.AST.StripFlags;
	closeStrip?: hbs.AST.StripFlags;
	inverseStrip?: hbs.AST.StripFlags;
}): boolean {
	const strips = [node.strip, node.openStrip, node.closeStrip, node.inverseStrip];
	return strips.some((strip) => strip !== undefined && (strip.open || strip.close));
}

function lintMustache(
	node: hbs.AST.MustacheStatement,
	context: LintInput,
	issues: LintIssues,
): void {
	if (hasStrip(node)) {
		issues.errors.push("whitespace control {{~ }} is not allowed");
		return;
	}
	if (node.escaped === false) {
		issues.errors.push("triple braces {{{ }}} are not allowed");
		return;
	}
	if (node.params.length > 0 || hasPairs(node.hash)) {
		issues.errors.push("interpolation takes no arguments");
		return;
	}
	if (node.path.type !== "PathExpression") {
		issues.errors.push(`interpolation: expected a variable name, got ${node.path.type}`);
		return;
	}
	const problem = variablePathProblem(node.path as hbs.AST.PathExpression, "interpolation", context);
	if (problem !== null) issues.errors.push(problem);
}

function lintBlock(
	node: hbs.AST.BlockStatement,
	context: LintInput,
	issues: LintIssues,
): void {
	if (hasStrip(node)) {
		issues.errors.push("whitespace control {{~ }} is not allowed");
		return;
	}
	const name = node.path;
	if (
		name.type !== "PathExpression" ||
		name.data ||
		name.depth !== 0 ||
		name.parts.length !== 1 ||
		!(BLOCK_HELPERS as readonly string[]).includes(name.parts[0])
	) {
		issues.errors.push(`block {{#${name.original}}} is not allowed — only if and unless`);
		return;
	}
	if (node.params.length !== 1) {
		issues.errors.push(`${name.parts[0]} takes exactly one condition`);
		return;
	}
	if (hasPairs(node.hash)) {
		issues.errors.push(`${name.parts[0]} takes no hash arguments`);
		return;
	}
	const blockPrograms: Array<hbs.AST.Program | undefined> = [node.program, node.inverse];
	for (const program of blockPrograms) {
		if (program === undefined) continue;
		if ((program.blockParams ?? []).length > 0) {
			issues.errors.push("block params as |x| are not allowed");
			return;
		}
	}
	const condition = node.params[0] as hbs.AST.Expression;
	lintCondition(condition, context, issues);
}

/**
 * Condition grammar (expr.ts): `eq`/`in` over a variable and string
 * literals, `and`/`or`/`not` over subexpressions, a bare name — a boolean
 * variable. A value expression (`concat`, a literal) is not a condition.
 * Names and literals are checked against the declared variables and their
 * values lists.
 */
function lintCondition(condition: hbs.AST.Expression, context: LintInput, issues: LintIssues): void {
	const parsed = exprFromHbs(condition);
	if (isExprProblem(parsed)) {
		issues.errors.push(parsed.problem);
		return;
	}
	if (parsed.kind === "literal" || parsed.kind === "concat") {
		issues.errors.push(`condition must be a comparison or a boolean variable, got a value expression`);
		return;
	}
	for (const atom of exprAtoms(parsed)) lintAtom(atom, context, issues);
}

function lintAtom(atom: ExprAtom, context: LintInput, issues: LintIssues): void {
	const what = atom.kind === "var" ? "condition" : "first condition argument";
	const resolved = resolveReference(atom.name, what, context);
	if ("problem" in resolved) {
		issues.errors.push(resolved.problem);
		return;
	}
	if (atom.kind === "var") {
		if (!isBooleanVariable(resolved.name, context)) {
			issues.errors.push(
				`condition: variable "${resolved.name}" is not boolean — expected values true/false`,
			);
		}
		return;
	}
	const values = context.variables[resolved.name];
	for (const value of atom.kind === "eq" ? [atom.value] : atom.values) {
		issues.warnings.push(...literalWarnings(resolved.name, value, values));
	}
}

/** A bare name condition is legal for a variable with values `true`/`false`. */
function isBooleanVariable(name: string, context: LintInput): boolean {
	const values = context.variables[name];
	return values !== undefined && values.length > 0 && values.every((value) => value === "true" || value === "false");
}

type VariableReference = { name: string; agent: string | null };

/** Reference parsing: `vllm` — regular, `vllm@` — any subagent, `vllm@foo` — agent `foo`. */
function parseReference(part: string): VariableReference | { problem: string } {
	const at = part.indexOf("@");
	if (at === -1) return { name: part, agent: null };
	const name = part.slice(0, at);
	const agent = part.slice(at + 1);
	if (name === "") return { problem: `"${part}": @ qualifier without a variable name` };
	if (agent !== "" && !isAgentName(agent)) return { problem: `"${part}": invalid agent name` };
	return { name, agent };
}

/** The variable the name refers to — with the `@` qualifier rules — or the problem. */
function resolveReference(
	name: string,
	what: string,
	context: LintInput,
): VariableReference | { problem: string } {
	const reference = parseReference(name);
	if ("problem" in reference) return { problem: `${what}: ${reference.problem}` };
	const qualifierProblem = checkQualifier(reference, what, context);
	if (qualifierProblem !== null) return { problem: qualifierProblem };
	if (!isDeclaredVariable(reference.name, context)) {
		return { problem: `${what}: variable "${reference.name}" is not declared` };
	}
	return reference;
}

/** Error: the path is not a declared variable. `null` — all good. */
function variablePathProblem(
	path: hbs.AST.PathExpression,
	what: string,
	context: LintInput,
): string | null {
	if (path.data) return `${what}: @data references are not allowed`;
	if (path.depth !== 0) return `${what}: context paths ../ are not allowed`;
	if (path.parts.length !== 1) return `${what}: "${path.original}" — expected a variable name`;
	const resolved = resolveReference(path.parts[0], what, context);
	return "problem" in resolved ? resolved.problem : null;
}

function checkQualifier(
	reference: VariableReference,
	what: string,
	context: LintInput,
): string | null {
	if (reference.agent === null) return null;
	const original = reference.agent === "" ? `${reference.name}@` : `${reference.name}@${reference.agent}`;
	if (context.agentName === undefined) {
		return `${what}: "${original}" — @ qualifier is only allowed in agent files`;
	}
	if (reference.agent !== "" && reference.agent !== context.agentName) {
		return `${what}: "${original}" — in agent file "${context.agentName}" only "${reference.name}@" and "${reference.name}@${context.agentName}" are allowed`;
	}
	return null;
}

function isDeclaredVariable(name: string, context: LintInput): boolean {
	return (IMPLICIT_VARIABLE_NAMES as readonly string[]).includes(name) || Object.hasOwn(context.variables, name);
}

function lintPartial(
	node: hbs.AST.PartialStatement,
	context: LintInput,
	issues: LintIssues,
): void {
	if (hasStrip(node)) {
		issues.errors.push("whitespace control {{~ }} is not allowed");
		return;
	}
	if (hasPairs(node.hash)) {
		issues.errors.push("partial takes no hash arguments");
		return;
	}
	// Static partial: the name is a path (without a leading dot) or a quoted
	// string literal (names with a dot, e.g. ".pi/…").
	const rawName = node.name as hbs.AST.Expression;
	if (rawName.type === "PathExpression") {
		if (node.params.length > 0) {
			issues.errors.push("partial takes no arguments");
			return;
		}
		staticPartial((rawName as hbs.AST.PathExpression).original, context, issues);
		return;
	}
	if (rawName.type === "StringLiteral") {
		if (node.params.length > 0) {
			issues.errors.push("partial takes no arguments");
			return;
		}
		staticPartial((rawName as hbs.AST.StringLiteral).value, context, issues);
		return;
	}
	if (node.params.length > 0) {
		issues.errors.push("partial takes no arguments");
		return;
	}
	lintDynamicPartial(node.name as hbs.AST.SubExpression, context, issues);
}

function staticPartial(name: string, context: LintInput, issues: LintIssues): void {
	const nameProblem = staticPartialNameProblem(name);
	if (nameProblem) {
		issues.errors.push(nameProblem);
		return;
	}
	if (!context.partials.exists(name)) {
		issues.errors.push(`partial "${name}" not found`);
	}
}

function staticPartialNameProblem(name: string): string | null {
	if (name === "") return "partial name is empty";
	if (name.startsWith("/") || name.startsWith("\\")) {
		return `partial "${name}" escapes the root`;
	}
	if (name.includes("..") || name.includes("\\")) {
		return `partial "${name}" escapes the root`;
	}
	return null;
}

type ConcatSegment = { kind: "literal"; value: string } | { kind: "variable"; name: string };

function lintDynamicPartial(
	subexpr: hbs.AST.SubExpression,
	context: LintInput,
	issues: LintIssues,
): void {
	const name = subexpr.path;
	if (
		name.type !== "PathExpression" ||
		name.data ||
		name.depth !== 0 ||
		name.parts.length !== 1 ||
		name.parts[0] !== "concat"
	) {
		issues.errors.push(`dynamic partial: expected concat of segments, got "${name.original}"`);
		return;
	}
	if (hasPairs(subexpr.hash)) {
		issues.errors.push("dynamic partial: concat takes no hash arguments");
		return;
	}
	if (subexpr.params.length === 0) {
		issues.errors.push("dynamic partial: concat without segments");
		return;
	}
	const segments: ConcatSegment[] = [];
	for (const rawParam of subexpr.params) {
		const param = rawParam as hbs.AST.Expression;
		if (param.type === "StringLiteral") {
			segments.push({ kind: "literal", value: (param as hbs.AST.StringLiteral).value });
			continue;
		}
		if (param.type === "PathExpression") {
			const path = param as hbs.AST.PathExpression;
			if (path.data || path.depth !== 0 || path.parts.length !== 1) {
				issues.errors.push(`dynamic partial: "${path.original}" — expected a variable name`);
				return;
			}
			const reference = parseReference(path.parts[0]);
			if ("problem" in reference) {
				issues.errors.push(`dynamic partial: ${reference.problem}`);
				return;
			}
			const qualifierProblem = checkQualifier(reference, "dynamic partial", context);
			if (qualifierProblem !== null) {
				issues.errors.push(qualifierProblem);
				return;
			}
			if (!isDeclaredVariable(reference.name, context)) {
				issues.errors.push(`dynamic partial: variable "${reference.name}" is not declared`);
				return;
			}
			segments.push({ kind: "variable", name: reference.name });
			continue;
		}
		issues.errors.push(`dynamic partial: segment must be a literal or a variable, got ${param.type}`);
		return;
	}

	const variables = segments.filter(
		(segment): segment is Extract<ConcatSegment, { kind: "variable" }> => segment.kind === "variable",
	);
	for (const variable of variables) {
		const values = context.variables[variable.name];
		// An empty successful list is as unresolvable as a missing list.
		if (values === undefined || values.length === 0) {
			issues.errors.push(
				`dynamic partial: variable "${variable.name}" has no values list — nothing to resolve`,
			);
			return;
		}
	}
	for (const resolved of resolveConcatNames(segments, context.variables)) {
		if (!context.partials.exists(resolved)) {
			// Early warning instead of a failure mid-session: the value may
			// never be selected, but the missing include is worth naming.
			issues.warnings.push(`dynamic partial: name "${resolved}" not found`);
		}
	}
}

function resolveConcatNames(segments: ConcatSegment[], variables: Record<string, string[] | undefined>): string[] {
	let names = [""];
	for (const segment of segments) {
		const next: string[] = [];
		if (segment.kind === "literal") {
			for (const name of names) next.push(`${name}${segment.value}`);
		} else {
			for (const name of names) {
				for (const value of variables[segment.name] ?? []) next.push(`${name}${value}`);
			}
		}
		names = next;
	}
	return names;
}

function renderLinted(
	source: string,
	view: Record<string, string>,
	context: LintInput,
	warnings?: string[],
): string {
	let program: hbs.AST.Program;
	try {
		program = Handlebars.parse(source);
	} catch (error) {
		throw new Error(parseProblem(source, error));
	}
	const texts = loadPartials(collectPartialNames(program, view), view, context, warnings);

	const environment = Handlebars.create();
	environment.registerHelper("eq", eqHelper);
	environment.registerHelper("in", inHelper);
	environment.registerHelper("and", andHelper);
	environment.registerHelper("or", orHelper);
	environment.registerHelper("not", notHelper);
	environment.registerHelper("if", ifHelper);
	environment.registerHelper("unless", unlessHelper);
	environment.registerHelper("concat", concatHelper);
	for (const [name, text] of texts) {
		environment.registerPartial(name, text);
	}
	const template = environment.compile(source, {
		knownHelpersOnly: true,
		noEscape: true,
		knownHelpers: { eq: true, in: true, and: true, or: true, not: true, concat: true, if: true, unless: true },
	});
	return template(view);
}

function collectPartialNames(program: hbs.AST.Program, view: Record<string, string>): string[] {
	const names: string[] = [];
	const visit = (node: hbs.AST.Node): void => {
		switch (node.type) {
			case "PartialStatement":
				names.push(partialName(node as hbs.AST.PartialStatement, view));
				return;
			case "PartialBlockStatement":
				throw new Error("block {{#> }} is not allowed");
			case "BlockStatement": {
				const block = node as hbs.AST.BlockStatement;
				const blockPrograms: Array<hbs.AST.Program | undefined> = [block.program, block.inverse];
				for (const program of blockPrograms) {
					if (program === undefined) continue;
					for (const statement of program.body) visit(statement);
				}
				return;
			}
			default:
				return;
		}
	};
	for (const node of program.body) visit(node);
	return names;
}

/**
 * Include closure for this pass: each included file is read on disk (the
 * resolver caches per pass) and nested includes are followed, so files that
 * are not included are never read. A missing include is an error naming the
 * resolved value; the include text passes the same lint as a source —
 * without an agent identity, so an `@` qualifier in an include is an error —
 * a vocabulary violation or a parse failure fails the includer, warnings
 * are collected.
 */
function loadPartials(
	names: readonly string[],
	view: Record<string, string>,
	context: LintInput,
	warnings?: string[],
): Map<string, string> {
	const texts = new Map<string, string>();
	const queue = [...names];
	while (queue.length > 0) {
		const name = queue.pop() as string;
		if (texts.has(name)) continue;
		const text = context.partials.read(name);
		if (text === undefined) throw new Error(`partial "${name}" not found`);
		const lint = lintPart(text, { variables: context.variables, partials: context.partials });
		if (lint.problem !== null) throw new Error(`partial "${name}": ${lint.problem}`);
		for (const warning of lint.warnings) warnings?.push(`partial "${name}": ${warning}`);
		texts.set(name, text);
		const program = Handlebars.parse(text);
		for (const nested of collectPartialNames(program, view)) queue.push(nested);
	}
	return texts;
}

function partialName(node: hbs.AST.PartialStatement, view: Record<string, string>): string {
	const rawName = node.name as hbs.AST.Expression;
	if (rawName.type === "PathExpression") return (rawName as hbs.AST.PathExpression).original;
	if (rawName.type === "StringLiteral") return (rawName as hbs.AST.StringLiteral).value;
	const subexpr = node.name as hbs.AST.SubExpression;
	if (subexpr.type !== "SubExpression" || subexpr.path.parts.length !== 1 || subexpr.path.parts[0] !== "concat") {
		throw new Error("dynamic partial name: expected concat");
	}
	let name = "";
	for (const rawParam of subexpr.params) {
		const param = rawParam as hbs.AST.Expression;
		if (param.type === "StringLiteral") {
			name += (param as hbs.AST.StringLiteral).value;
		} else if (param.type === "PathExpression") {
			const path = param as hbs.AST.PathExpression;
			if (path.parts.length !== 1) {
				throw new Error(`dynamic partial name: "${path.original}" — expected a variable name`);
			}
			const value = view[path.parts[0]];
			if (value === undefined) {
				throw new Error(`partial "${path.original}": variable has no value — name cannot resolve`);
			}
			name += value;
		} else {
			throw new Error(
				`dynamic partial name: segment must be a literal or a variable, got ${param.type}`,
			);
		}
	}
	return name;
}

function eqHelper(left: unknown, right: unknown): boolean {
	return left === right;
}

/** Helper arguments: the options/data object is always last — take strings only. */
function stringArgs(args: unknown[]): string[] {
	return args.filter((arg): arg is string => typeof arg === "string");
}

function inHelper(...args: unknown[]): boolean {
	const values = stringArgs(args);
	const [value, ...rest] = values;
	return rest.includes(value);
}

function andHelper(...args: unknown[]): boolean {
	return conditionArgs(args).every(isTruthy);
}

function orHelper(...args: unknown[]): boolean {
	return conditionArgs(args).some(isTruthy);
}

function notHelper(...args: unknown[]): boolean {
	return !isTruthy(conditionArgs(args)[0]);
}

/** Condition operands: strings and booleans — the options object is dropped. */
function conditionArgs(args: unknown[]): unknown[] {
	return args.filter((arg) => typeof arg === "string" || typeof arg === "boolean");
}

interface BlockOptions {
	fn: (context: unknown) => string;
	inverse: (context: unknown) => string;
}

/**
 * Block condition: a helper result (`true`/`false`) or a view value — a bare
 * boolean variable is true only for the string `"true"`.
 */
function ifHelper(this: unknown, condition: unknown, options: BlockOptions): string {
	return isTruthy(condition) ? options.fn(this) : options.inverse(this);
}

function unlessHelper(this: unknown, condition: unknown, options: BlockOptions): string {
	return isTruthy(condition) ? options.inverse(this) : options.fn(this);
}

function concatHelper(...args: unknown[]): string {
	return stringArgs(args).join("");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
