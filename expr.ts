/**
 * Variable expressions: one language for `compute` in `template.json` and
 * for `{{#if (…)}}`/`{{#unless (…)}}` conditions in templates.
 *
 * An expression produces a value: a variable name (the variable's value),
 * `concat` of literals and variables (as in partial names), or a condition
 * (`eq`/`in` over a variable and string literals, `and`/`or`/`not`) — a
 * boolean as the strings `"true"`/`"false"`. Literals are arguments of
 * `concat` and comparisons; a standalone expression is a call or a variable
 * name.
 *
 * A string expression is parsed through the Handlebars parser: the source is
 * wrapped into `{{#if (…)}}{{/if}}` and the resulting AST is validated here —
 * the same path a template condition takes (`exprFromHbs`), so config and
 * templates share one grammar and one validator.
 *
 * Truthiness: `true` (a helper result) or the string `"true"` (a view value).
 * Any other value — including `"false"` and non-empty strings — is false, so
 * a bare variable condition means exactly `eq name "true"`.
 */

import Handlebars from "handlebars";

/** pi thinking levels: condition literals are compared against this set. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Boolean values of a boolean variable in the view and in its values list. */
export const BOOLEAN_VALUES = ["true", "false"] as const;

export type ExprNode =
	| { kind: "literal"; value: string }
	| { kind: "var"; name: string }
	| { kind: "concat"; args: Array<{ kind: "literal"; value: string } | { kind: "var"; name: string }> }
	| { kind: "eq"; name: string; value: string }
	| { kind: "in"; name: string; values: string[] }
	| { kind: "and"; args: ExprNode[] }
	| { kind: "or"; args: ExprNode[] }
	| { kind: "not"; arg: ExprNode };

/** Atoms that reference variables: comparisons and variable names. */
export type ExprAtom = { kind: "var"; name: string } | { kind: "eq"; name: string; value: string } | { kind: "in"; name: string; values: string[] };

/** A parsed expression or the reason it is not one. */
export type ExprParse = ExprNode | { problem: string };

export function isExprProblem(parse: ExprParse): parse is { problem: string } {
	return "problem" in parse;
}

/**
 * Expression source → AST. The source is written as the condition of
 * `{{#if (…)}}` without the outer parentheses (`in model "a" "b"`,
 * `concat "modes/" mode ".md"`, `or is_flash (eq level "off")`, `is_flash`);
 * a parenthesized call is accepted as well.
 */
export function parseExpr(source: string): ExprParse {
	const trimmed = source.trim();
	const condition = trimmed.startsWith("(") ? trimmed : `(${trimmed})`;
	let program: hbs.AST.Program;
	try {
		program = Handlebars.parse(`{{#if ${condition}\n}}{{/if}}`);
	} catch (error) {
		return { problem: `expression does not parse: ${errorMessage(error)}` };
	}
	const block = program.body[0];
	if (block === undefined || block.type !== "BlockStatement") return { problem: "expression is not a condition" };
	const param = (block as hbs.AST.BlockStatement).params[0];
	if (param === undefined) return { problem: "expression is empty" };
	return exprFromHbs(param as hbs.AST.Expression);
}

/**
 * Handlebars expression → expression AST. Names are taken verbatim (`vllm`,
 * `vllm@` in agent files); whether a name is a declared variable is the
 * caller's check. Grammar: `concat` of literals and variables; a comparison
 * `eq`/`in` (a variable and string literals); `and`/`or`/`not` over
 * conditions; a bare name — the variable's value.
 */
export function exprFromHbs(node: hbs.AST.Expression): ExprParse {
	if (node.type === "StringLiteral") {
		return { kind: "literal", value: (node as hbs.AST.StringLiteral).value };
	}
	if (node.type === "PathExpression") {
		const path = node as hbs.AST.PathExpression;
		if (path.data || path.depth !== 0 || path.parts.length !== 1) {
			return { problem: `"${path.original}" — expected a variable name` };
		}
		return { kind: "var", name: path.parts[0] };
	}
	if (node.type !== "SubExpression") {
		return { problem: `expression operand must be a helper call or a variable, got ${node.type}` };
	}
	const call = node as hbs.AST.SubExpression;
	if (call.hash !== undefined && call.hash.pairs.length > 0) {
		return { problem: "expression takes no hash arguments" };
	}
	const params = call.params as hbs.AST.Expression[];
	// `("x")` is a literal — the parenthesized form of an atom. The AST types
	// declare a PathExpression here; the parser also admits literals.
	const path = call.path as hbs.AST.Expression;
	if (params.length === 0 && path.type === "StringLiteral") {
		return { kind: "literal", value: (path as hbs.AST.StringLiteral).value };
	}
	if (
		path.type !== "PathExpression" ||
		(path as hbs.AST.PathExpression).data ||
		(path as hbs.AST.PathExpression).depth !== 0 ||
		(path as hbs.AST.PathExpression).parts.length !== 1
	) {
		return { problem: "expression: expected a helper call" };
	}
	const helper = (path as hbs.AST.PathExpression).parts[0];
	const isHelper = (["concat", "eq", "in", "and", "or", "not"] as readonly string[]).includes(helper);
	// `(name)` is a variable — the parenthesized form of an atom; a helper
	// name keeps its arity check below.
	if (params.length === 0 && !isHelper) {
		return { kind: "var", name: helper };
	}
	if (helper === "concat") return concatExpr(params);
	if (helper === "eq" || helper === "in") return comparisonExpr(helper, params);
	if (helper === "and" || helper === "or") {
		if (params.length < 1) return { problem: `${helper} takes at least one operand` };
		const args: ExprNode[] = [];
		for (const param of params) {
			const operand = exprFromHbs(param);
			if (isExprProblem(operand)) return operand;
			if (operand.kind === "literal" || operand.kind === "concat") {
				return { problem: `${helper}: an operand must be a condition or a variable` };
			}
			args.push(operand);
		}
		return helper === "and" ? { kind: "and", args } : { kind: "or", args };
	}
	if (helper === "not") {
		if (params.length !== 1) return { problem: "not takes exactly one operand" };
		const operand = exprFromHbs(params[0]);
		if (isExprProblem(operand)) return operand;
		if (operand.kind === "literal" || operand.kind === "concat") {
			return { problem: "not: an operand must be a condition or a variable" };
		}
		return { kind: "not", arg: operand };
	}
	return { problem: `helper "${helper}" is not allowed — only concat, eq, in, and, or, not` };
}

/** `concat` of literals and variables — the partial-name vocabulary. */
function concatExpr(params: hbs.AST.Expression[]): ExprParse {
	if (params.length < 1) return { problem: "concat takes at least one segment" };
	const args: Array<{ kind: "literal"; value: string } | { kind: "var"; name: string }> = [];
	for (const param of params) {
		if (param.type === "StringLiteral") {
			args.push({ kind: "literal", value: (param as hbs.AST.StringLiteral).value });
			continue;
		}
		if (param.type === "PathExpression") {
			const path = param as hbs.AST.PathExpression;
			if (path.data || path.depth !== 0 || path.parts.length !== 1) {
				return { problem: `concat: "${path.original}" — expected a variable name` };
			}
			args.push({ kind: "var", name: path.parts[0] });
			continue;
		}
		return { problem: `concat: a segment must be a literal or a variable, got ${param.type}` };
	}
	return { kind: "concat", args };
}

function comparisonExpr(helper: "eq" | "in", params: hbs.AST.Expression[]): ExprParse {
	const [first, ...rest] = params;
	if (first === undefined || first.type !== "PathExpression") {
		return { problem: "first condition argument: expected a variable name" };
	}
	const firstPath = first as hbs.AST.PathExpression;
	if (firstPath.data || firstPath.depth !== 0 || firstPath.parts.length !== 1) {
		return { problem: `first condition argument: "${firstPath.original}" — expected a variable name` };
	}
	if (helper === "eq" && rest.length !== 1) return { problem: "eq takes exactly one value to compare" };
	if (helper === "in" && rest.length < 1) return { problem: "in takes at least one value" };
	const literals: string[] = [];
	for (const rawValue of rest) {
		if (rawValue.type !== "StringLiteral") {
			return { problem: `value must be a string literal, got ${rawValue.type}` };
		}
		literals.push((rawValue as hbs.AST.StringLiteral).value);
	}
	const name = firstPath.parts[0];
	return helper === "eq"
		? { kind: "eq", name, value: literals[0] }
		: { kind: "in", name, values: literals };
}

/** Atoms that reference variables, depth first. */
export function exprAtoms(node: ExprNode): ExprAtom[] {
	switch (node.kind) {
		case "literal":
			return [];
		case "var":
			return [node];
		case "concat":
			return node.args.filter((arg) => arg.kind === "var");
		case "eq":
		case "in":
			return [node];
		case "and":
		case "or":
			return node.args.flatMap(exprAtoms);
		case "not":
			return exprAtoms(node.arg);
	}
}

/** Variable names referenced by the expression. */
export function exprVariables(node: ExprNode): string[] {
	return [...new Set(exprAtoms(node).map((atom) => atom.name))];
}

/** The value of the expression over a variable view. */
export function evalValue(node: ExprNode, view: Readonly<Record<string, string>>): string {
	switch (node.kind) {
		case "literal":
			return node.value;
		case "var":
			return view[node.name] ?? "";
		case "concat":
			return node.args.map((arg) => (arg.kind === "literal" ? arg.value : view[arg.name] ?? "")).join("");
		case "eq":
			return (view[node.name] ?? "") === node.value ? "true" : "false";
		case "in":
			return node.values.includes(view[node.name] ?? "") ? "true" : "false";
		case "and":
			return node.args.every((arg) => isTruthy(evalValue(arg, view))) ? "true" : "false";
		case "or":
			return node.args.some((arg) => isTruthy(evalValue(arg, view))) ? "true" : "false";
		case "not":
			return isTruthy(evalValue(node.arg, view)) ? "false" : "true";
	}
}

/** Condition truth of the expression. */
export function evalExpr(node: ExprNode, view: Readonly<Record<string, string>>): boolean {
	return isTruthy(evalValue(node, view));
}

/** Truthiness of a condition value: `true` or the string `"true"`. */
export function isTruthy(value: unknown): boolean {
	return value === true || value === "true";
}

/**
 * Lint warning for a condition literal: outside the variable values list or
 * not a thinking level (the list may be outdated — a warning, not an error).
 */
export function literalWarnings(variable: string, value: string, values: readonly string[] | undefined): string[] {
	const warnings: string[] = [];
	if (variable === "level" && !(THINKING_LEVELS as readonly string[]).includes(value)) {
		warnings.push(`value "${value}" is not a thinking level`);
	}
	if (values !== undefined && !values.includes(value)) {
		warnings.push(`value "${value}" is not in the values list of variable "${variable}"`);
	}
	return warnings;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
