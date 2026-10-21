/**
 * probe.mjs — a framework-free scenario run of the template engine and
 * consumption points.
 *
 * Zone A (vars.ts, render.ts): `template.json` parsing, the shell value
 * contract, `@` value resolution, lint and render, the two-stage agent file
 * render, canonical serialization.
 *
 * Zone B: target file lock (re-entry, short ownership, foreign ownership),
 * the source list and include resolution, versions and mtime+size comparison,
 * set render with file failures, the agent header `model`/`level` seam,
 * subagent identity, session lifecycle (start apply, section delivery with
 * replacement and addition, variable change, recompute, foreign read and
 * spawn brackets, `/reload`). Scenarios run sequentially (shell commands are
 * async; lock tests rely on real time).
 *
 * Zone C (ui-model.ts): `"var"` records (strict payload, last value, `"role"`
 * ignored), overridable variable selection and `/template` menu composition
 * (including rewriting files on disk), computed value age, the status line
 * and the quick-switch rings (`ctrl+r`/`alt+r`).
 *
 * Live scenarios against a pi process — in the zone B report
 * (`.task/current/23_template-implementation/2_consumption/report.md`).
 *
 * Run: node probe.mjs
 */
import { deepStrictEqual, throws } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import {
	canonicalJson,
	computeView,
	evaluateExpressions,
	firstShellLine,
	isComputedVariable,
	loadVarsConfig,
	parseShellLines,
	parseVarsConfig,
	subagentValue,
} from "./vars.ts";
import { lintTemplate, renderAgentBody, renderAgentHeader, renderTemplate } from "./render.ts";
import { agentHeaderFacts, renderAgentFile } from "./agent.ts";
import { agentNameFromPrompt, agentNameFromSessionName } from "./identity.ts";
import { LOCK_TTL_MS, acquireLock, ownsLock, releaseLock, writeTargetUnderLock } from "./lock.ts";
import { renderSources } from "./render-set.ts";
import { collectSpawnTargets, TemplateSession } from "./session.ts";
import { createPartialResolver, discoverSources } from "./sources.ts";
import {
	changeVariable,
	formatAge,
	menuRowSegments,
	variableStatusMark,
	menuItems,
	nextStatusVariable,
	nextVariableValue,
	readVarOverrides,
	statusLineText,
	statusVariableChoices,
	variableFacts,
} from "./ui-model.ts";
import { ContextVersions, sourceStamps, stampsDiffer } from "./versions.ts";

const scenarios = [];

function scenario(name, run) {
	scenarios.push({ name, run });
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

/** Canonical form for comparison: object key order is not significant. */
function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const sorted = {};
		for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
		return sorted;
	}
	return value;
}

function assertEqual(actual, expected, message) {
	try {
		deepStrictEqual(canonicalize(actual), canonicalize(expected));
	} catch {
		throw new Error(`${message}: ${inspect(actual)} !== ${inspect(expected)}`);
	}
}

async function withTempDir(run) {
	const dir = mkdtempSync(join(tmpdir(), "templates-probe-"));
	try {
		return await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const AGENT_DIR = "/agent";
const PROJECT_DIR = "/proj";

/** Config from an explicit variables object. */
function config(vars) {
	return { vars };
}

/** Explicitly empty environment: collisions do not depend on the dev machine. */
const NO_ENV = {};

function makeExecutor(responses) {
	const calls = [];
	const execute = async (command, cwd, env) => {
		calls.push({ command, cwd, env: { ...env } });
		const response = responses[command];
		if (response === undefined) throw new Error(`command not described in the response table: ${command}`);
		return {
			code: response.code ?? 0,
			stdout: response.stdout ?? "",
			stderr: response.stderr ?? "",
			error: response.error,
		};
	};
	return { execute, calls };
}

/** Mock include resolver: one table is both the existence list and the text source. */
function mockPartials(texts) {
	return { exists: (name) => texts.has(name), read: (name) => texts.get(name) };
}

/** Include texts of the engine scenarios: name → text. */
const PARTIAL_TEXTS = new Map([
	["roles/a.md", "Role A"],
	["roles/b.md", "Role B"],
	[".pi/skills/x/SKILL.md", "Project skill"],
]);

const PARTIALS = mockPartials(PARTIAL_TEXTS);
const NO_PARTIALS = mockPartials(new Map());

/** Lint context: variable value lists and the include resolver of both roots. */
function lintContext(overrides = {}) {
	return {
		variables: overrides.variables ?? { role: ["a", "b"], vllm: ["on", "off"], flash: ["true", "false"], free: undefined },
		partials: overrides.partials ?? PARTIALS,
		agentName: overrides.agentName,
	};
}

function renderContext(view, variables) {
	return {
		view,
		variables: variables ?? { role: ["a", "b"], vllm: ["on", "off"], free: undefined },
		partials: PARTIALS,
	};
}

/**
 * Like zone B: extracts `model`/`level` from the rendered header by simple
 * string parsing, otherwise the preliminary values. YAML is not given to the engine.
 */
function extractModelLevel(header, preliminary) {
	const line = (name) => header.split("\n").find((item) => item.startsWith(`${name}: `));
	const model = line("model");
	const level = line("level");
	return {
		model: model === undefined ? preliminary.model : model.slice("model: ".length),
		level: level === undefined ? preliminary.level : level.slice("level: ".length),
	};
}

// ============================================================================
// template.json parsing
// ============================================================================

scenario("when_template_json_missing_then_empty_config", async () => {
	await withTempDir(async (dir) => {
		assertEqual(loadVarsConfig(dir, NO_ENV), { vars: {} }, "no file — empty config");
	});
});

scenario("when_template_json_file_then_loaded", async () => {
	await withTempDir(async (dir) => {
		writeFileSync(join(dir, "template.json"), JSON.stringify({ vars: { vllm: { values: ["on", "off"], initial: "on" } } }));
		assertEqual(loadVarsConfig(dir, NO_ENV), { vars: { vllm: { values: ["on", "off"], initial: "on" } } }, "file not parsed");

		writeFileSync(join(dir, "template.json"), "{");
		const broken = loadVarsConfig(dir, NO_ENV);
		assert("problem" in broken && /does not parse/.test(broken.problem), "broken file not rejected");
	});
});

scenario("when_template_json_valid_then_all_fields_parsed", async () => {
	const loaded = parseVarsConfig(
		JSON.stringify({
			vars: {
				role: {
					values: { shell: "basename -s .md roles/*.md" },
					initial: "preflight",
					"@": "develop",
					"@plan": "design",
				},
				vllm: { values: ["on", "off"], initial: "on" },
				git_branch: { initial: { shell: "git rev-parse --abbrev-ref HEAD" }, cwd: "project" },
				revision: { initial: { env: "REVISION" } },
			},
		}),
		NO_ENV,
	);
	assert(!("problem" in loaded), `config rejected: ${loaded.problem ?? ""}`);
	assertEqual(
		loaded,
		{
			vars: {
				role: {
					values: { shell: "basename -s .md roles/*.md" },
					initial: "preflight",
					subagentAny: "develop",
					subagentByName: { plan: "design" },
				},
				vllm: { values: ["on", "off"], initial: "on" },
				git_branch: { initial: { shell: "git rev-parse --abbrev-ref HEAD" }, cwd: "project" },
				revision: { initial: { env: "REVISION" } },
			},
		},
		"fields in wrong places",
	);
});

scenario("when_template_json_rejected_then_problem_reported", async () => {
	const cases = [
		["invalid JSON", "{"],
		["not an object", "[]"],
		["unknown top-level key", JSON.stringify({ vars: {}, oops: 1 })],
		["unknown variable key", JSON.stringify({ vars: { a: { initial: "x", extra: 1 } } })],
		["values is not a string list", JSON.stringify({ vars: { a: { values: [1] } } })],
		["values shell with an extra key", JSON.stringify({ vars: { a: { values: { shell: "ls", extra: 1 } } } })],
		["initial mixes shell and env", JSON.stringify({ vars: { a: { initial: { shell: "ls", env: "X" } } } })],
		["initial is neither string nor command", JSON.stringify({ vars: { a: { initial: 5 } } })],
		["cwd outside the set", JSON.stringify({ vars: { a: { cwd: "both" } } })],
		["name is not an identifier", JSON.stringify({ vars: { "a-b": {} } })],
		["declaring model", JSON.stringify({ vars: { model: { initial: "x" } } })],
		["declaring level", JSON.stringify({ vars: { level: { initial: "x" } } })],
		["@ key is not a string", JSON.stringify({ vars: { a: { "@": 5 } } })],
		["@plan key is not a string", JSON.stringify({ vars: { a: { "@plan": 5 } } })],
		["invalid agent name in key", JSON.stringify({ vars: { a: { "@foo bar": "x" } } })],
		["renamed key current", JSON.stringify({ vars: { a: { current: "x" } } })],
	];
	for (const [name, text] of cases) {
		const loaded = parseVarsConfig(text, NO_ENV);
		assert("problem" in loaded, `${name}: accepted`);
		assert(loaded.problem.length > 0, `${name}: empty message`);
	}
	const collision = parseVarsConfig(JSON.stringify({ vars: { PATH: { initial: "x" } } }), { PATH: "bin" });
	assert("problem" in collision && /collides/.test(collision.problem), "collision with env not rejected");
});

scenario("when_status_variable_rejected_then_problem_names_variable", async () => {
	const undeclared = parseVarsConfig(JSON.stringify({ vars: { role: { values: ["a"] } }, statusVariable: "mode" }), NO_ENV);
	assert("problem" in undeclared && undeclared.problem.includes('"mode"'), `undeclared name not named: ${undeclared.problem ?? ""}`);
	const noList = parseVarsConfig(JSON.stringify({ vars: { role: { initial: "a" } }, statusVariable: "role" }), NO_ENV);
	assert("problem" in noList && noList.problem.includes('"role"'), `variable without a list not named: ${noList.problem ?? ""}`);
	const emptyList = parseVarsConfig(JSON.stringify({ vars: { role: { values: [] } }, statusVariable: "role" }), NO_ENV);
	assert("problem" in emptyList, "an empty value list was accepted");
	const notString = parseVarsConfig(JSON.stringify({ vars: {}, statusVariable: 5 }), NO_ENV);
	assert("problem" in notString, "a non-string statusVariable was accepted");

	const loaded = parseVarsConfig(JSON.stringify({ vars: { role: { values: ["a"] } }, statusVariable: "role" }), NO_ENV);
	assertEqual(loaded, { vars: { role: { values: ["a"] } }, statusVariable: "role" }, "statusVariable not parsed");
	// A shell list is declared but its emptiness is known only at runtime.
	const shellList = parseVarsConfig(JSON.stringify({ vars: { role: { values: { shell: "ls" } } }, statusVariable: "role" }), NO_ENV);
	assert(!("problem" in shellList), "a shell value list was rejected");
});

scenario("when_compute_declared_then_form_parsed", async () => {
	const loaded = parseVarsConfig(
		JSON.stringify({
			vars: {
				mode: { values: ["plan", "code"] },
				is_flash: { compute: 'in model "a" "b"' },
				paren: { compute: "(is_flash)" },
				copy: { compute: "is_flash" },
				file: { compute: 'concat "modes/" mode ".md"' },
				literal: { compute: '"flash"' },
			},
		}),
		NO_ENV,
	);
	assert(!("problem" in loaded), `form rejected: ${loaded.problem ?? ""}`);
	assertEqual(loaded.vars.file.compute, 'concat "modes/" mode ".md"', "compute field not parsed");
	assertEqual(loaded.vars.literal.compute, '"flash"', "literal expression not parsed");
});

scenario("when_compute_conflicts_then_problem_names_variable", async () => {
	const cases = [
		["compute with initial", { compute: 'in model "a"', initial: "x" }],
		["compute with values", { compute: 'in model "a"', values: ["true"] }],
	];
	for (const [name, spec] of cases) {
		const loaded = parseVarsConfig(JSON.stringify({ vars: { is_flash: spec } }), NO_ENV);
		assert("problem" in loaded, `${name}: accepted`);
		assert(loaded.problem.includes('"is_flash"'), `${name}: variable not named: ${loaded.problem ?? ""}`);
	}
});

scenario("when_compute_expression_broken_then_problem_names_variable", async () => {
	const cases = [
		["foreign helper", "frob x"],
		["in without values", "in"],
		["eq without a value", "eq a"],
		["eq with two values", 'eq a "b" "c"'],
		["non-literal comparison", "eq a b"],
		["not without an operand", "(not)"],
		["not with two operands", '(not (eq a "b") (eq a "c"))'],
		["literal operand of or", '(or "x" (eq a "b"))'],
		["condition operand of concat", 'concat (eq a "b")'],
		["concat without segments", "(concat)"],
		["hash arguments", '(eq a="b")'],
		["empty", ""],
		["garbage", "a b ("],
		["not a string", 42],
	];
	for (const [name, compute] of cases) {
		const loaded = parseVarsConfig(JSON.stringify({ vars: { a: { values: ["b"] }, is_flash: { compute } } }), NO_ENV);
		assert("problem" in loaded, `${name}: accepted`);
		assert(loaded.problem.includes('"is_flash"'), `${name}: variable not named: ${loaded.problem ?? ""}`);
	}
});

scenario("when_compute_references_then_declared_earlier_only", async () => {
	const forward = parseVarsConfig(
		JSON.stringify({ vars: { first: { compute: 'eq second "x"' }, second: { values: ["x"] } } }),
		NO_ENV,
	);
	assert("problem" in forward && forward.problem.includes('"second"'), `forward reference accepted: ${forward.problem ?? ""}`);
	const unknown = parseVarsConfig(JSON.stringify({ vars: { is_flash: { compute: 'eq ghost "x"' } } }), NO_ENV);
	assert("problem" in unknown && unknown.problem.includes('"ghost"'), `unknown reference accepted: ${unknown.problem ?? ""}`);
	const self = parseVarsConfig(JSON.stringify({ vars: { loop: { compute: 'eq loop "x"' } } }), NO_ENV);
	assert("problem" in self && self.problem.includes('"loop"'), `self reference accepted: ${self.problem ?? ""}`);
	const implicit = parseVarsConfig(JSON.stringify({ vars: { is_flash: { compute: 'in model "a" "b"' } } }), NO_ENV);
	assert(!("problem" in implicit), `implicit reference rejected: ${implicit.problem ?? ""}`);
});

scenario("when_reserved_name_declared_then_problem", async () => {
	for (const name of ["and", "or", "not", "eq", "in"]) {
		const loaded = parseVarsConfig(JSON.stringify({ vars: { [name]: { initial: "x" } } }), NO_ENV);
		assert("problem" in loaded, `${name}: accepted`);
		assert(loaded.problem.includes(name), `${name}: name not in the message`);
	}
});

scenario("when_status_variable_is_derived_then_accepted", async () => {
	const loaded = parseVarsConfig(
		JSON.stringify({ vars: { is_flash: { compute: 'in model "a"' } }, statusVariable: "is_flash" }),
		NO_ENV,
	);
	assert(!("problem" in loaded), `derived status variable rejected: ${loaded.problem ?? ""}`);
});

scenario("when_subagent_value_outside_boolean_domain_then_problem", async () => {
	const any = parseVarsConfig(JSON.stringify({ vars: { is_flash: { compute: 'in model "a"', "@": "yes" } } }), NO_ENV);
	assert("problem" in any && any.problem.includes('"@"'), `foreign "@" accepted: ${any.problem ?? ""}`);
	const byName = parseVarsConfig(JSON.stringify({ vars: { is_flash: { compute: 'in model "a"', "@plan": "" } } }), NO_ENV);
	assert("problem" in byName && byName.problem.includes('"@plan"'), `foreign "@plan" accepted: ${byName.problem ?? ""}`);
	const inDomain = parseVarsConfig(
		JSON.stringify({ vars: { is_flash: { compute: 'in model "a"', "@": "false", "@plan": "true" } } }),
		NO_ENV,
	);
	assert(!("problem" in inDomain), `domain values rejected: ${inDomain.problem ?? ""}`);
	const stringDerived = parseVarsConfig(
		JSON.stringify({ vars: { label: { compute: 'concat "x" model', "@": "anything" } } }),
		NO_ENV,
	);
	assert(!("problem" in stringDerived), `string derived refused a foreign value: ${stringDerived.problem ?? ""}`);
});

// ============================================================================
// shell value contract
// ============================================================================

scenario("when_shell_stdout_then_lines_trimmed_deduped", async () => {
	assertEqual(parseShellLines("a\n\n b \nb\nA\n"), ["a", "b", "A"], "lines not collapsed");
	assertEqual(parseShellLines(""), [], "empty stdout");
	assertEqual(parseShellLines("\r\nb\r\n"), ["b"], "CRLF not parsed");
	assertEqual(firstShellLine("first\nsecond\n"), "first", "initial does not take the first line");

	const { execute } = makeExecutor({ ls: { stdout: "x\n\n y \ny\nX\n" } });
	const report = await computeView({
		config: config({ files: { values: { shell: "ls" } } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: {},
		execute,
	});
	assertEqual(report.values.files, ["x", "y", "X"], "value list from stdout not collapsed");
});

scenario("when_view_computed_then_initial_env_and_shell_values", async () => {
	const { execute } = makeExecutor({ "echo one": { stdout: "one\n" }, "echo two": { stdout: "two\n" } });
	const report = await computeView({
		config: config({
			first: { initial: { shell: "echo one" } },
			second: { initial: { shell: "echo two" } },
			later_static: { initial: "L" },
			env_lookup: { initial: { env: "FOO" } },
			env_missing: { initial: { env: "MISSING" } },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "deepseek/deepseek-flash", level: "low" },
		env: { FOO: "bar" },
		execute,
	});
	assertEqual(report.problems, [], "unexpected problems");
	assertEqual(report.warnings, [], "unexpected warnings");
	assertEqual(
		report.view,
		{
			model: "deepseek/deepseek-flash",
			level: "low",
			first: "one",
			second: "two",
			later_static: "L",
			env_lookup: "bar",
			env_missing: "",
		},
		"view not built",
	);
});

scenario("when_command_starts_then_env_has_known_view_in_declaration_order", async () => {
	const { execute, calls } = makeExecutor({ "cmd A": { stdout: "a\n" }, "cmd B": { stdout: "b\n" } });
	await computeView({
		config: config({
			a: { initial: { shell: "cmd A" } },
			b: { initial: { shell: "cmd B" } },
			static_later: { initial: "S" },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "m" },
		env: { FOO: "bar" },
		execute,
	});
	// The first variable's command: its own value does not exist yet, the
	// static value of a later variable is known without computation.
	assertEqual(calls[0].env, { FOO: "bar", model: "m", static_later: "S" }, "environment of the first command");
	// The second command sees the computed first one and not its own.
	assertEqual(calls[1].env, { FOO: "bar", model: "m", static_later: "S", a: "a" }, "environment of the second command");
});

scenario("when_cwd_zones_then_command_runs_in_declared_dir", async () => {
	const { execute, calls } = makeExecutor({ "cmd A": { stdout: "a\n" }, "cmd B": { stdout: "b\n" } });
	await computeView({
		config: config({
			a: { initial: { shell: "cmd A" }, cwd: "project" },
			b: { initial: { shell: "cmd B" } },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: {},
		execute,
	});
	assertEqual(calls[0].cwd, PROJECT_DIR, "cwd project not applied");
	assertEqual(calls[1].cwd, AGENT_DIR, "cwd agent not applied");
});

scenario("when_static_initial_overridden_then_override_wins_in_view_and_env", async () => {
	const { execute, calls } = makeExecutor({ "cmd B": { stdout: "b\n" } });
	const report = await computeView({
		config: config({
			role: { values: ["a", "b"], initial: "preflight" },
			later: { initial: { shell: "cmd B" } },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "m", role: "develop" },
		env: {},
		execute,
	});
	assertEqual(report.problems, [], "static initial override is not an error");
	assertEqual(report.view.role, "develop", "override did not win over initial");
	assertEqual(report.values.role, ["a", "b"], "value list lost");
	assertEqual(calls[0].env.role, "develop", "override did not reach the command environment");
	assert(!("later" in calls[0].env), "the command can see its own value");
});

scenario("when_override_of_computed_then_problem_and_computed_value", async () => {
	const { execute } = makeExecutor({ "echo computed": { stdout: "computed\n" } });
	const computed = await computeView({
		config: config({ slow: { initial: { shell: "echo computed" } } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { slow: "input" },
		env: {},
		execute,
	});
	assertEqual(
		computed.problems,
		['variable "slow": input value ignored — variable is computed, read-only'],
		"no read-only problem",
	);
	assertEqual(computed.view, { slow: "computed" }, "computed value lost");

	// A forbidden override does not leak into the environment of the next commands:
	// a failed computation leaves the variable without a value.
	const { execute: executeNext, calls: nextCalls } = makeExecutor({ false: { code: 1 }, "cmd B": { stdout: "b\n" } });
	await computeView({
		config: config({
			slow: { initial: { shell: "false" } },
			b: { initial: { shell: "cmd B" } },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { slow: "input" },
		env: {},
		execute: executeNext,
	});
	assert(!("slow" in nextCalls[1].env), "forbidden override leaked into the environment");

	const lookup = await computeView({
		config: config({ fx: { initial: { env: "FOO" } } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { fx: "X" },
		env: { FOO: "bar" },
		execute: async () => {
			throw new Error("no commands expected");
		},
	});
	assertEqual(lookup.problems.length, 1, "no read-only problem for env");
	assertEqual(lookup.view, { fx: "bar" }, "env lookup lost");
});

scenario("when_compute_evaluated_then_value_and_implied_list", async () => {
	const derived = config({
		is_flash: { compute: 'in model "a" "b"' },
		label: { compute: 'concat "m:" model' },
	});
	const on = await computeView({
		config: derived,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "a" },
		env: {},
		execute: noShell,
	});
	assertEqual(on.view.is_flash, "true", "boolean expression did not evaluate");
	assertEqual(on.view.label, "m:a", "string expression did not evaluate");
	assertEqual(on.values.is_flash, ["true", "false"], "boolean variable lost its values list");
	assertEqual(on.values.label, undefined, "string derived variable got a values list");
	const off = await computeView({
		config: derived,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "c" },
		env: {},
		execute: noShell,
	});
	assertEqual(off.view.is_flash, "false", "the other branch not evaluated");
	assertEqual(off.view.label, "m:c", "string expression not re-evaluated");
});

scenario("when_compute_chained_then_derived_follows_inputs", async () => {
	const chained = config({
		is_flash: { compute: 'in model "a" "b"' },
		is_dumb: { compute: 'or is_flash (eq level "off")' },
		is_copy: { compute: "is_dumb" },
	});
	const cases = [
		[{ model: "a", level: "high" }, "true", "true", "true"],
		[{ model: "a", level: "off" }, "true", "true", "true"],
		[{ model: "c", level: "off" }, "false", "true", "true"],
		[{ model: "c", level: "high" }, "false", "false", "false"],
	];
	for (const [implicit, flash, dumb, copy] of cases) {
		const report = await computeView({
			config: chained,
			agentDir: AGENT_DIR,
			projectDir: PROJECT_DIR,
			implicit,
			env: {},
			execute: noShell,
		});
		assertEqual(report.view.is_flash, flash, `is_flash for ${JSON.stringify(implicit)}`);
		assertEqual(report.view.is_dumb, dumb, `is_dumb for ${JSON.stringify(implicit)}`);
		assertEqual(report.view.is_copy, copy, `is_copy for ${JSON.stringify(implicit)}`);
	}
});

scenario("when_compute_overridden_then_input_wins_over_expression_and_subagent", async () => {
	const report = await computeView({
		config: config({ is_flash: { compute: 'in model "a"', subagentAny: "true" } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "a", is_flash: "false" },
		agentName: "foo",
		env: {},
		execute: noShell,
	});
	assertEqual(report.view.is_flash, "false", "input did not win");
	assertEqual(report.problems, [], "an override of a derived variable is not an error");
});

scenario("when_input_outside_boolean_domain_then_problem_and_expression_value", async () => {
	const report = await computeView({
		config: config({ is_flash: { compute: 'in model "a"' } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "a", is_flash: "yes" },
		env: {},
		execute: noShell,
	});
	assertEqual(report.view.is_flash, "true", "the expression value lost to a foreign input");
	assertEqual(
		report.problems,
		['variable "is_flash": input value "yes" ignored — the variable is boolean (true/false)'],
		"no problem for a foreign input",
	);

	// A string derived variable has no domain: the input wins as is.
	const label = await computeView({
		config: config({ label: { compute: 'concat "m" model' } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "a", label: "raw" },
		env: {},
		execute: noShell,
	});
	assertEqual(label.view.label, "raw", "string derived variable refused the input");
	assertEqual(label.problems, [], "a foreign input of a string variable is not a problem");
});

scenario("when_subagent_value_then_wins_over_compute", async () => {
	const report = await computeView({
		config: config({ is_flash: { compute: 'in model "a"', subagentAny: "false" } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "a" },
		agentName: "foo",
		env: {},
		execute: noShell,
	});
	assertEqual(report.view.is_flash, "false", "the @ value lost to the expression");
	assertEqual(report.problems, [], "a @ value of a derived variable is not a problem");
});

scenario("when_compute_literals_outside_lists_then_warnings", async () => {
	const report = await computeView({
		config: config({
			role: { values: ["a", "b"] },
			warned: { compute: 'or (eq role "z") (eq level "ultra")' },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "m" },
		env: {},
		execute: noShell,
	});
	assertEqual(
		report.warnings,
		['value "z" is not in the values list of variable "role"', 'value "ultra" is not a thinking level'],
		"no warnings about the literals",
	);
	const dedup = await computeView({
		config: config({ role: { values: ["a"] }, warned: { compute: 'or (eq role "z") (eq role "z")' } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "m" },
		env: {},
		execute: noShell,
	});
	assertEqual(dedup.warnings.length, 1, "a duplicate literal warning not collapsed");
});

scenario("when_compute_expression_broken_in_view_then_problem_and_no_value", async () => {
	const report = await computeView({
		config: config({ is_flash: { compute: "frob x" } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: {},
		env: {},
		execute: noShell,
	});
	assertEqual(report.view.is_flash, "", "a broken expression gave a value");
	assertEqual(report.problems.length, 1, "a broken expression gave no problem");
	assert(report.problems[0].includes('"is_flash"'), `variable not named: ${report.problems[0] ?? ""}`);
});

scenario("when_expressions_evaluated_over_view_then_derived_follows", async () => {
	const view = { model: "b", is_flash: "true", is_copy: "true", is_stuck: "old" };
	evaluateExpressions(
		config({
			is_flash: { compute: 'in model "a"' },
			is_copy: { compute: "is_flash" },
			is_stuck: { compute: "frob x" },
		}),
		view,
		{ overridden: new Set(["is_copy"]) },
	);
	assertEqual(view.is_flash, "false", "the derived value did not follow the model");
	assertEqual(view.is_copy, "true", "an overridden variable was recomputed");
	assertEqual(view.is_stuck, "old", "a broken expression changed the value");
});

scenario("when_variable_value_empty_then_comparisons_match_empty", async () => {
	const report = await computeView({
		config: config({
			empty_one: { initial: { shell: "fail" } },
			eq_empty: { compute: 'eq empty_one ""' },
			in_empty: { compute: 'in empty_one "" "x"' },
			bare: { compute: "empty_one" },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: {},
		env: {},
		execute: async () => ({ code: 1, stdout: "", stderr: "boom" }),
	});
	assertEqual(report.view.empty_one, "", "the failed command left a value");
	assertEqual(report.view.eq_empty, "true", "eq over an empty value");
	assertEqual(report.view.in_empty, "true", "in over an empty value");
	assertEqual(report.view.bare, "", "a copy of an empty value");
});

scenario("when_shell_exit_nonzero_then_problem_and_no_value", async () => {
	const { execute } = makeExecutor({ false: { code: 3, stderr: "boom" }, "echo ok": { stdout: "ok\n" } });
	const report = await computeView({
		config: config({
			bad_values: { values: { shell: "false" } },
			bad_initial: { initial: { shell: "false" } },
			good: { initial: { shell: "echo ok" } },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: {},
		execute,
	});
	assertEqual(
		report.problems,
		[
			'template.json: variable "bad_values": values list: command exited with code 3: boom',
			'template.json: variable "bad_initial": initial value: command exited with code 3: boom',
		],
		"no non-zero exit messages",
	);
	assertEqual(report.values.bad_values, undefined, "failed list is not empty");
	assertEqual(report.values.bad_initial, undefined, "failed initial is not empty");
	assertEqual(report.view, { bad_values: "", bad_initial: "", good: "ok" }, "view on command failure");
});

scenario("when_shell_timeout_then_problem", async () => {
	await withTempDir(async (dir) => {
		const started = Date.now();
		const report = await computeView({
			config: config({ hanging: { initial: { shell: "sleep 30" } } }),
			agentDir: dir,
			projectDir: dir,
			env: { ...process.env },
		});
		const elapsed = Date.now() - started;
		assertEqual(report.view, { hanging: "" }, "value is not empty");
		assertEqual(
			report.problems,
			['template.json: variable "hanging": initial value: command did not run: timeout 5000 ms'],
			"no timeout message",
		);
		// The command was killed by timeout, not finished.
		assert(elapsed >= 4500 && elapsed < 30000, `timeout did not fire: ${elapsed} ms`);
	});
});

scenario("when_shell_timeout_then_background_grandchild_killed", async () => {
	await withTempDir(async (dir) => {
		const marker = join(dir, "marker.txt");
		// A background descendant writes the marker after 7 s — after the timeout (5 s).
		const command = `( sleep 7; printf done > '${marker}' ) & sleep 30`;
		const report = await computeView({
			config: config({ hanging: { initial: { shell: command } } }),
			agentDir: dir,
			projectDir: dir,
			env: { ...process.env },
		});
		assertEqual(
			report.problems,
			['template.json: variable "hanging": initial value: command did not run: timeout 5000 ms'],
			"no timeout message",
		);
		// Wait for the moment the marker would have been written if the descendant survived.
		await new Promise((resolve) => setTimeout(resolve, 3000));
		assert(!existsSync(marker), "background descendant survived the timeout");
	});
});

scenario("when_commands_mention_later_computed_then_warning", async () => {
	const { execute } = makeExecutor({ "echo $b": { stdout: "a\n" }, "echo later": { stdout: "b\n" } });
	const report = await computeView({
		config: config({
			a: { initial: { shell: "echo $b" } },
			b: { initial: { shell: "echo later" } },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: {},
		execute,
	});
	assertEqual(
		report.warnings,
		['variable "a": the command mentions variable "b" declared later — its value will not be in the environment'],
		"no warning about a later variable",
	);

	const staticLater = await computeView({
		config: config({
			first: { initial: { shell: "echo $static_later $PATH" } },
			static_later: { initial: "S" },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: {},
		execute: makeExecutor({ "echo $static_later $PATH": { stdout: "x\n" } }).execute,
	});
	assertEqual(staticLater.warnings, [], "warning about a static/external variable");
});

scenario("when_later_variable_replaced_by_subagent_value_then_no_warning", async () => {
	const loaded = parseVarsConfig(
		JSON.stringify({
			vars: {
				a: { initial: { shell: "echo $b" } },
				b: { initial: { shell: "later-would-run" }, "@": "known" },
			},
		}),
		NO_ENV,
	);
	assert(!("problem" in loaded), "config rejected");
	const { execute, calls } = makeExecutor({ "echo $b": { stdout: "a\n" } });
	const report = await computeView({
		config: loaded,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		agentName: "plan",
		env: {},
		execute,
	});
	assertEqual(report.warnings, [], "false warning on @ replacement");
	assertEqual(calls.length, 1, "extra commands were computed");
	assertEqual(calls[0].env.b, "known", "subagent value did not reach the environment");
	assertEqual(report.view, { a: "a", b: "known" }, "subagent view");
});

scenario("when_values_report_then_key_for_every_declared", async () => {
	const { execute } = makeExecutor({ cmd: { stdout: "v\n" } });
	const report = await computeView({
		config: config({
			listy: { values: ["x"], initial: "x" },
			valueless: { initial: "y" },
			computed: { initial: { shell: "cmd" } },
		}),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: {},
		execute,
	});
	assertEqual(Object.keys(report.values).sort(), ["computed", "listy", "valueless"], "not every declared variable has a key");
	assertEqual(report.values.listy, ["x"], "static list corrupted");
	assertEqual(report.values.valueless, undefined, "a variable without a list is not undefined");
	assertEqual(report.values.computed, undefined, "a computed variable without a list is not undefined");
});

scenario("when_values_shell_empty_then_dynamic_partial_rejected", async () => {
	const { execute } = makeExecutor({ true: { stdout: "" } });
	const report = await computeView({
		config: config({ role: { values: { shell: "true" } } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: {},
		execute,
	});
	assertEqual(report.values.role, [], "list is not empty");
	const result = lintTemplate('{{> (concat "roles/" role ".md")}}', {
		variables: report.values,
		partials: PARTIALS,
	});
	assert(
		result.problem !== null && /no values list/.test(result.problem),
		"an empty list is not treated as no list",
	);
});

scenario("when_variable_named_like_prototype_then_value_applied", async () => {
	// The config currently rejects such names via an env collision check; the
	// scenario builds the config directly and checks that computeView does not
	// lose a value on `in` (Object.hasOwn is used).
	const report = await computeView({
		config: config({ constructor: { initial: "x" }, toString: { initial: { env: "MISSING" } } }),
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: {},
		execute: async () => {
			throw new Error("no commands expected");
		},
	});
	assertEqual(report.view.constructor, "x", "prototype-named value lost");
	assertEqual(report.view.toString, "", "env lookup by prototype name lost");
});

// ============================================================================
// Subagent values
// ============================================================================

scenario("when_subagent_value_resolved_then_name_over_any_over_initial", async () => {
	const loaded = parseVarsConfig(
		JSON.stringify({
			vars: {
				role: { values: ["a", "b"], initial: "preflight", "@": "develop", "@plan": "design" },
				vllm: { initial: "on" },
			},
		}),
		NO_ENV,
	);
	assert(!("problem" in loaded), "config rejected");
	const role = loaded.vars.role;
	assertEqual(subagentValue(role, "plan"), "design", "@<name> did not win over @");
	assertEqual(subagentValue(role, "other"), "develop", "@ not applied");
	assertEqual(subagentValue(loaded.vars.vllm, "plan"), undefined, "without keys the value is not undefined");

	const forName = await computeView({
		config: loaded,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "m", level: "low" },
		agentName: "plan",
		env: {},
		execute: async () => {
			throw new Error("no commands expected");
		},
	});
	assertEqual(forName.view.role, "design", "view of subagent plan");
	assertEqual(forName.view.vllm, "on", "subagent machine initial");

	const forAny = await computeView({
		config: loaded,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		agentName: "other",
		env: {},
		execute: async () => {
			throw new Error("no commands expected");
		},
	});
	assertEqual(forAny.view.role, "develop", "view of any subagent");
	assertEqual(forAny.view.vllm, "on", "machine initial of any subagent");

	const forParent = await computeView({
		config: loaded,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: {},
		execute: async () => {
			throw new Error("no commands expected");
		},
	});
	assertEqual(forParent.view.role, "preflight", "parent view");
});

scenario("when_subagent_key_replaces_computed_then_no_shell_run", async () => {
	const loaded = parseVarsConfig(
		JSON.stringify({
			vars: {
				branch: { initial: { shell: "should-not-run" }, "@": "trunk" },
				envvar: { initial: { env: "FOO" }, "@": "fixed" },
			},
		}),
		NO_ENV,
	);
	assert(!("problem" in loaded), "config rejected");
	assertEqual(
		loaded.vars.branch,
		{ initial: { shell: "should-not-run" }, subagentAny: "trunk" },
		"@ key not parsed",
	);

	let calls = 0;
	const child = await computeView({
		config: loaded,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		agentName: "plan",
		env: { FOO: "raw" },
		execute: async () => {
			calls += 1;
			return { code: 0, stdout: "computed\n", stderr: "" };
		},
	});
	assertEqual(calls, 0, "a computed variable with an @ key was computed anyway");
	assertEqual(child.view, { branch: "trunk", envvar: "fixed" }, "@ keys did not replace computed values");

	const parent = await computeView({
		config: loaded,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		env: { FOO: "raw" },
		execute: async () => ({ code: 0, stdout: "computed\n", stderr: "" }),
	});
	assertEqual(parent.view, { branch: "computed", envvar: "raw" }, "parent did not compute its values");

	assert(isComputedVariable(loaded.vars.branch), "computed without @ is not read-only?");
	assert(!isComputedVariable(loaded.vars.branch, "plan"), "@ key did not remove computed status");
});

scenario("when_subagent_value_then_session_override_wins", async () => {
	const loaded = parseVarsConfig(
		JSON.stringify({ vars: { role: { values: ["a"], initial: "preflight", "@": "develop" } } }),
		NO_ENV,
	);
	assert(!("problem" in loaded), "config rejected");
	const report = await computeView({
		config: loaded,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { role: "dev-session" },
		agentName: "plan",
		env: {},
		execute: async () => {
			throw new Error("no commands expected");
		},
	});
	assertEqual(report.problems, [], "subagent value must not be read-only");
	assertEqual(report.view.role, "dev-session", "session override did not win over the subagent value");
});

// ============================================================================
// Canonical serialization
// ============================================================================

scenario("when_canonical_json_then_stable_key_order", async () => {
	const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
	const b = canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
	assertEqual(a, b, "key order affects serialization");
	assertEqual(
		a,
		'{\n  "a": {\n    "c": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ],\n    "d": 2\n  },\n  "b": 1\n}\n',
		"non-canonical text",
	);
});

// ============================================================================
// Lint: legal forms
// ============================================================================

scenario("when_legal_forms_then_lint_passes", async () => {
	const generic = [
		["text without tags", "plain markdown"],
		["comment", "a {{! note }} b"],
		["interpolation", "role {{role}}, vllm {{vllm}}"],
		["if + eq + else", '{{#if (eq vllm "on")}}A{{else}}B{{/if}}'],
		["unless + level", '{{#unless (eq level "high")}}A{{/unless}}'],
		["in of two", '{{#if (in model "m1" "m2")}}A{{/if}}'],
		["nested blocks", '{{#if (eq vllm "on")}}{{#if (eq role "a")}}X{{/if}}{{/if}}'],
		["agent static partial", "A\n{{> roles/a.md}}\nB"],
		["project static partial in quotes", '{{> ".pi/skills/x/SKILL.md"}}'],
		["dynamic partial", '{{> (concat "roles/" role ".md")}}'],
		["frontmatter with a template", '---\nkey: "{{vllm}}"\n---\nbody'],
		// A variable without a value list: interpolation and eq are legal.
		["interpolation without a list", "branch: {{free}}"],
		["eq without a list", '{{#if (eq free "x")}}A{{else}}B{{/if}}'],
		["boolean variable condition", "{{#if flash}}A{{else}}B{{/if}}"],
		["parenthesized variable condition", "{{#if (flash)}}A{{/if}}"],
		["unless over a boolean variable", "{{#unless flash}}A{{/unless}}"],
		["not over a boolean variable", "{{#if (not flash)}}A{{/if}}"],
		["or of a variable and a comparison", '{{#if (or flash (eq vllm "on"))}}A{{/if}}'],
		["nested and with parens", '{{#if (and (in model "m1") (not (eq level "low")))}}A{{/if}}'],
		["or of three operands", '{{#if (or flash (eq vllm "on") (eq level "off"))}}A{{/if}}'],
	];
	for (const [name, source] of generic) {
		const result = lintTemplate(source, lintContext());
		assertEqual(result.problem, null, `${name}: ${result.problem ?? ""}`);
	}

	const agent = lintContext({ agentName: "foo" });
	const agentForms = [
		["@ any subagent", "{{[vllm@]}}"],
		["@<name> of an agent", "{{[vllm@foo]}}"],
		["@ in a condition", '{{#if (eq [vllm@] "on")}}A{{/if}}'],
		["@<name> in unless", '{{#unless (eq [level@foo] "high")}}A{{/unless}}'],
		["@ in a dynamic partial", '{{> (concat "roles/" [role@] ".md")}}'],
		["model@/level@ in the body", "---\nmodel: plain\n---\n{{[model@]}} {{[level@foo]}}"],
		["model@/level@ in the header", "---\nmodel: {{[model@]}}\nlevel: {{[level@foo]}}\n---\nbody"],
	];
	for (const [name, source] of agentForms) {
		const result = lintTemplate(source, agent);
		assertEqual(result.problem, null, `${name}: ${result.problem ?? ""}`);
	}
});

// ============================================================================
// Lint: rejection table
// ============================================================================

scenario("when_rejected_forms_then_problem_reported", async () => {
	const genericRejections = [
		["undeclared interpolation", "{{nope}}"],
		["undeclared in eq", '{{#if (eq nope "x")}}A{{/if}}'],
		["compound path", "{{a.b}}"],
		["triple braces", "{{{vllm}}}"],
		["whitespace control", '{{~#if (eq vllm "on")}}A{{/if}}'],
		["@data path", '{{#if (eq @root.vllm "on")}}A{{/if}}'],
		["../ climb", '{{#if (eq ../vllm "on")}}A{{/if}}'],
		["hash in a condition", '{{#if (eq vllm "on" ok=1)}}A{{/if}}'],
		["hash in interpolation", "{{vllm foo=1}}"],
		["interpolation arguments", "{{vllm 1}}"],
		["foreign block", "{{#each items}}A{{/each}}"],
		["bare path of a non-boolean variable", "{{#if vllm}}A{{/if}}"],
		["or without operands", "{{#if (or)}}A{{/if}}"],
		["and without operands", "{{#if (and)}}A{{/if}}"],
		["not with two operands", '{{#if (not (eq vllm "on") (eq vllm "off"))}}A{{/if}}'],
		["literal operand of or", '{{#if (or "x" (eq vllm "on"))}}A{{/if}}'],
		["value expression as a condition", '{{#if (concat "a" role)}}A{{/if}}'],
		["concat operand of a condition", '{{#if (or (concat "a" role) (eq vllm "on"))}}A{{/if}}'],
		["nested foreign helper", "{{#if (and (frob role))}}A{{/if}}"],
		["undeclared operand", '{{#if (or flash (eq nope "x"))}}A{{/if}}'],
		["foreign helper", '{{#if (frob vllm)}}A{{/if}}'],
		["eq with two values", '{{#if (eq vllm "a" "b")}}A{{/if}}'],
		["in without values", "{{#if (in vllm)}}A{{/if}}"],
		["non-literal in comparison", "{{#if (eq vllm other)}}A{{/if}}"],
		["block params", '{{#if (eq vllm "on") as |x|}}A{{/if}}'],
		["partial block", "{{#> roles/a.md}}A{{/roles/a.md}}"],
		["partial with an argument", "{{> roles/a.md 1}}"],
		["partial not found", "{{> ghost.md}}"],
		["quoted partial not found", '{{> "ghost.md"}}'],
		["partial with ..", "{{> ../x.md}}"],
		["absolute partial", "{{> /x.md}}"],
		["partial with a backslash", "{{> a\\b.md}}"],
		["quoted partial with ..", '{{> "../x.md"}}'],
		["quoted absolute partial", '{{> "/x.md"}}'],
		["decorator", "{{:log}}"],
		["unclosed tag", '{{#if (eq vllm "on")}}A'],
		["qualifier outside agent files", "{{[vllm@]}}"],
		["model qualifier outside agent files", "{{[model@]}}"],
		["dynamic partial: foreign helper", "{{> (eq role)}}"],
		["dynamic partial: undeclared segment", '{{> (concat "roles/" other ".md")}}'],
		["dynamic partial: no value list", '{{> (concat "roles/" free ".md")}}'],
		["dynamic partial: no segments", "{{> (concat)}}"],
	];
	for (const [name, source] of genericRejections) {
		const result = lintTemplate(source, lintContext());
		assert(result.problem !== null, `${name}: accepted`);
		assert(result.problem.length > 0, `${name}: empty message`);
	}

	const agent = lintContext({ agentName: "foo" });
	const agentRejections = [
		["foreign agent name", "{{[vllm@bar]}}"],
		["invalid agent name", "{{[vllm@bad name]}}"],
		["double qualifier", "{{[vllm@foo@bar]}}"],
		["foreign agent name in the header", "---\nmodel: {{[model@bar]}}\n---\nbody"],
	];
	for (const [name, source] of agentRejections) {
		const result = lintTemplate(source, agent);
		assert(result.problem !== null, `${name}: accepted`);
	}

	// Header and body share one vocabulary: qualified references are legal in the header too.
	const headerQualified = lintTemplate("---\nmodel: {{[model@]}}\nlevel: {{[level@foo]}}\n---\n{{[model@]}}", agent);
	assertEqual(headerQualified.problem, null, "qualified references in the header rejected");
});

scenario("when_raw_qualifier_then_parse_hint", async () => {
	const result = lintTemplate("{{vllm@}}", lintContext());
	assert(result.problem !== null, "unparsed notation accepted");
	assert(result.problem.includes("hint"), `no hint about [vllm@]: ${result.problem}`);
});

scenario("when_lint_warnings_then_literal_outside_list_and_level", async () => {
	const outsideList = lintTemplate('{{#if (eq vllm "off")}}A{{/if}}', lintContext({ variables: { vllm: ["on"] } }));
	assertEqual(outsideList.problem, null, "legal form rejected");
	assertEqual(
		outsideList.warnings,
		['value "off" is not in the values list of variable "vllm"'],
		"no warning about the literal",
	);

	const level = lintTemplate('{{#if (eq level "ultra")}}A{{/if}}', lintContext());
	assertEqual(level.problem, null, "legal form rejected");
	assertEqual(level.warnings, ['value "ultra" is not a thinking level'], "no warning about the level");

	const valid = lintTemplate('{{#if (eq vllm "on")}}A{{/if}}', lintContext());
	assertEqual(valid.warnings, [], "false warning");

	// A value of the list without a file on disk is a warning, not a rejection:
	// the value may never be selected, and the failure would come mid-session.
	const missingDynamic = lintTemplate('{{> (concat "roles/" vllm ".md")}}', lintContext());
	assertEqual(missingDynamic.problem, null, "a missing dynamic name rejected the source");
	assertEqual(
		missingDynamic.warnings,
		['dynamic partial: name "roles/on.md" not found', 'dynamic partial: name "roles/off.md" not found'],
		"no warning about the missing dynamic names",
	);
});

// ============================================================================
// Render
// ============================================================================

scenario("when_rendered_then_conditions_interpolation_partials", async () => {
	const cases = [
		["eq matched", '{{#if (eq vllm "on")}}Y{{/if}}', { vllm: "on" }, "Y"],
		["eq did not match with else", '{{#if (eq vllm "on")}}Y{{else}}N{{/if}}', { vllm: "off" }, "N"],
		["in matched", '{{#if (in vllm "off" "x")}}Y{{/if}}', { vllm: "off" }, "Y"],
		["in missed", '{{#if (in vllm "off" "x")}}Y{{/if}}', { vllm: "on" }, ""],
		["unless", '{{#unless (eq level "high")}}Y{{/unless}}', { level: "low" }, "Y"],
		["nesting", '{{#if (eq vllm "on")}}{{#if (eq role "a")}}X{{/if}}{{/if}}', { vllm: "on", role: "a" }, "X"],
		["noEscape", "v {{vllm}}", { vllm: "a&b" }, "v a&b"],
		["static partial", "A {{> roles/a.md}} B", {}, "A Role A B"],
		["project partial in quotes", '{{> ".pi/skills/x/SKILL.md"}}', {}, "Project skill"],
		["partial in else", '{{#if (eq vllm "off")}}no{{else}}{{> roles/b.md}}{{/if}}', { vllm: "on" }, "Role B"],
		["dynamic partial", '{{> (concat "roles/" role ".md")}}', { role: "b" }, "Role B"],
		["frontmatter rendered as body", '---\nkey: "{{vllm}}"\n---\nbody', { vllm: "on" }, '---\nkey: "on"\n---\nbody'],
	];
	for (const [name, source, view, expected] of cases) {
		assertEqual(renderTemplate(source, renderContext(view)), expected, name);
	}
});

scenario("when_partial_missing_or_lint_broken_then_render_throws", async () => {
	throws(
		() => renderTemplate("{{> ghost.md}}", renderContext({})),
		/lint: partial "ghost.md" not found/,
		"missing partial did not throw",
	);
	throws(() => renderTemplate("{{nope}}", renderContext({})), /lint: .*is not declared/, "broken lint did not throw");
	throws(
		() => renderTemplate('{{> (concat "roles/" role ".md")}}', renderContext({}, { role: ["a", "b"], vllm: [] })),
		/partial "role": variable has no value/,
		"dynamic partial without a value did not throw",
	);
	// The lint of the name checks every value of the list; the value selected at
	// render has no file — the error names the resolved name.
	throws(
		() => renderTemplate('{{> (concat "roles/" role ".md")}}', renderContext({ role: "missing" })),
		/partial "roles\/missing.md" not found/,
		"a selected dynamic name missing on disk did not throw",
	);
});

scenario("when_include_text_lint_broken_then_includer_fails", async () => {
	const texts = new Map([
		["roles/bad.md", "{{nope}}"],
		["roles/qualified.md", "{{[vllm@]}}"],
	]);
	const partials = mockPartials(texts);
	throws(
		() => renderTemplate("A {{> roles/bad.md}} B", { view: {}, variables: { role: undefined }, partials }),
		/partial "roles\/bad.md": .*"nope" is not declared/,
		"a vocabulary violation in an include text did not fail the includer",
	);
	throws(
		() =>
			renderAgentBody("A {{> roles/qualified.md}} B", {
				agentName: "foo",
				parentView: {},
				subagentView: { vllm: "on" },
				variables: { vllm: ["on"] },
				partials,
			}),
		/partial "roles\/qualified.md": .*@ qualifier is only allowed in agent files/,
		"an @ qualifier in an include text was accepted",
	);
});

scenario("when_render_repeated_then_same_text", async () => {
	const source = 'Start {{vllm}} {{> roles/a.md}} {{#if (eq vllm "on")}}{{> roles/b.md}}{{/if}}';
	const first = renderTemplate(source, renderContext({ vllm: "on" }));
	const second = renderTemplate(source, {
		view: { vllm: "on" },
		variables: { vllm: ["on", "off"], role: ["a", "b"] },
		partials: mockPartials(new Map([...PARTIAL_TEXTS].reverse())),
	});
	assertEqual(second, first, "include order affects the render");
	assertEqual(first, "Start on Role A Role B", "text did not match");
});

scenario("when_qualified_boolean_operand_then_agent_files_only", async () => {
	const source = "{{#if (or [flag@] vllm)}}A{{/if}}";
	const variables = { flag: ["true", "false"], vllm: ["true", "false"] };
	const agent = lintTemplate(source, { variables, partials: PARTIALS, agentName: "foo" });
	assertEqual(agent.problem, null, `qualified operand rejected: ${agent.problem ?? ""}`);
	const outside = lintTemplate(source, { variables, partials: PARTIALS });
	assert(
		outside.problem !== null && outside.problem.includes("qualifier"),
		`outside agent files accepted: ${outside.problem ?? ""}`,
	);
});

scenario("when_boolean_variable_condition_then_only_true_is_truthy", async () => {
	const source = "{{#if is_flash}}A{{else}}B{{/if}}|{{#unless is_flash}}U{{/unless}}|{{#if (not is_flash)}}N{{/if}}";
	const variables = { is_flash: ["true", "false"] };
	const cases = [
		["true", "A||"],
		["false", "B|U|N"],
		["", "B|U|N"],
		["TRUE", "B|U|N"],
		["yes", "B|U|N"],
	];
	for (const [value, expected] of cases) {
		const rendered = renderTemplate(source, { view: { is_flash: value }, variables, partials: NO_PARTIALS });
		assertEqual(rendered, expected, `value "${value}"`);
	}
});

scenario("when_connectives_rendered_then_boolean_logic", async () => {
	const source =
		'{{#if (or is_flash (eq level "off"))}}R{{/if}}{{#if (and is_flash (eq level "off"))}}D{{/if}}{{#if (eq is_flash "false")}}F{{/if}}';
	const variables = { is_flash: ["true", "false"] };
	const cases = [
		[{ is_flash: "true", level: "off" }, "RD"],
		[{ is_flash: "true", level: "high" }, "R"],
		[{ is_flash: "false", level: "off" }, "RF"],
		[{ is_flash: "false", level: "high" }, "F"],
	];
	for (const [view, expected] of cases) {
		assertEqual(
			renderTemplate(source, { view, variables, partials: NO_PARTIALS }),
			expected,
			JSON.stringify(view),
		);
	}
});

scenario("when_boolean_variable_interpolated_then_string_value", async () => {
	const variables = { is_flash: ["true", "false"] };
	assertEqual(
		renderTemplate("{{is_flash}}", { view: { is_flash: "true" }, variables, partials: NO_PARTIALS }),
		"true",
		"true not printed",
	);
	assertEqual(
		renderTemplate("{{is_flash}}", { view: { is_flash: "false" }, variables, partials: NO_PARTIALS }),
		"false",
		"false not printed",
	);
});

// ============================================================================
// Two-stage agent file render
// ============================================================================

scenario("when_agent_file_two_stage_then_header_then_model_level_then_body", async () => {
	const source =
		[
			"---",
			'model: {{#if (eq [vllm@] "on")}}deepseek/deepseek-flash{{else}}other/model{{/if}}',
			"description: {{[role@]}}",
			"---",
			"Parent: {{vllm}}, child: {{[role@]}}, model: {{[model@]}}, level: {{[level@foo]}}",
		].join("\n") + "\n";
	const variables = { role: ["a", "b"], vllm: ["on", "off"] };
	const preliminary = { model: "prelim/model", level: "medium" };
	const base = {
		agentName: "foo",
		variables,
		partials: PARTIALS,
		parentView: { vllm: "off", role: "preflight" },
	};

	// YAML parsing is zone B: the engine receives extraction via a callback.
	const extract = (header) => extractModelLevel(header, preliminary);
	const stage1 = renderAgentHeader(
		source,
		{ ...base, subagentView: { vllm: "on", role: "design", ...preliminary } },
		extract,
	);
	assertEqual(
		stage1,
		{
			header: "---\nmodel: deepseek/deepseek-flash\ndescription: design\n---",
			model: "deepseek/deepseek-flash",
			level: "medium",
		},
		"header fixpoint is wrong",
	);

	const body = renderAgentBody(source, {
		...base,
		subagentView: { vllm: "on", role: "design", model: stage1.model, level: stage1.level },
	});
	assertEqual(
		body,
		"\nParent: off, child: design, model: deepseek/deepseek-flash, level: medium\n",
		"body rendered incorrectly",
	);

	const withoutFrontmatter = "Body {{[role@]}}, model {{[model@]}}\n";
	const defaults = { model: "default/model", level: "low" };
	const stage1Empty = renderAgentHeader(withoutFrontmatter, { ...base, subagentView: {} }, () => defaults);
	assertEqual(stage1Empty, { header: "", model: "default/model", level: "low" }, "without frontmatter the header is not empty");
	const stage2 = renderAgentBody(withoutFrontmatter, {
		...base,
		subagentView: { role: "design", ...defaults },
	});
	assertEqual(stage2, "Body design, model default/model\n", "body without frontmatter");
});

scenario("when_agent_subagent_value_missing_then_throws", async () => {
	const base = {
		agentName: "foo",
		variables: { role: ["a"], vllm: ["on"] },
		partials: PARTIALS,
		parentView: { vllm: "on" },
	};
	// A regular reference does not require a subagent value.
	assertEqual(renderAgentBody("{{vllm}}", { ...base, subagentView: {} }), "on", "regular reference broke");
	throws(
		() => renderAgentBody("{{[role@]}}", { ...base, subagentView: {} }),
		/subagent value for variable "role" is not set/,
		"missing subagent value did not throw",
	);
});

scenario("when_agent_header_qualified_values_then_actual_model_level", async () => {
	const source =
		[
			"---",
			'model: {{#if (eq [vllm@] "on")}}model/on{{else}}model/off{{/if}}',
			'level: {{#if (eq [vllm@] "on")}}high{{else}}low{{/if}}',
			"description: {{[model@]}}",
			"effort: {{[level@foo]}}",
			"---",
			"body",
		].join("\n") + "\n";
	const preliminary = { model: "prelim/model", level: "low" };
	const context = {
		agentName: "foo",
		variables: { vllm: ["on", "off"] },
		partials: PARTIALS,
		parentView: {},
		subagentView: { vllm: "on", ...preliminary },
	};
	// `@` references in the header get the actual stage 1 values, not the
	// preliminary ones: description and effort come out with fixpoint values.
	const stage1 = renderAgentHeader(source, context, (header) => extractModelLevel(header, preliminary));
	assertEqual(
		stage1,
		{
			header: "---\nmodel: model/on\nlevel: high\ndescription: model/on\neffort: high\n---",
			model: "model/on",
			level: "high",
		},
		"@ references in the header did not get actual values",
	);
});

scenario("when_agent_header_model_echo_then_fixpoint", async () => {
	const source = "---\nmodel: {{[model@]}}\n---\nbody\n";
	const preliminary = { model: "deepseek/deepseek-flash", level: "low" };
	const context = {
		agentName: "foo",
		variables: {},
		partials: PARTIALS,
		parentView: {},
		subagentView: { ...preliminary },
	};
	const stage1 = renderAgentHeader(source, context, (header) => extractModelLevel(header, preliminary));
	assertEqual(
		stage1,
		{
			header: "---\nmodel: deepseek/deepseek-flash\n---",
			model: "deepseek/deepseek-flash",
			level: "low",
		},
		"model@ in the header did not converge to the preliminary model",
	);
});

scenario("when_agent_header_settles_on_second_pass_then_fixpoint", async () => {
	// The model/level pair repeats, but the second pass text is stable: a
	// repeated state alone is not a cycle, text stabilization decides.
	const source =
		[
			"---",
			"model: fixed/model",
			'description: {{#if (eq [model@] "fixed/model")}}settled{{else}}waiting{{/if}}',
			"---",
			"body",
		].join("\n") + "\n";
	const preliminary = { model: "other/model", level: "low" };
	const context = {
		agentName: "foo",
		variables: {},
		partials: PARTIALS,
		parentView: {},
		subagentView: { ...preliminary },
	};
	const stage1 = renderAgentHeader(source, context, (header) => extractModelLevel(header, preliminary));
	assertEqual(stage1.header, "---\nmodel: fixed/model\ndescription: settled\n---", "header did not converge");
	assertEqual(stage1.model, "fixed/model", "fixpoint model");
});

scenario("when_agent_header_model_oscillates_then_error", async () => {
	const source = '---\nmodel: {{#if (eq [model@] "a")}}b{{else}}a{{/if}}\n---\nbody\n';
	const preliminary = { model: "c", level: "low" };
	const context = {
		agentName: "foo",
		variables: {},
		partials: PARTIALS,
		parentView: {},
		subagentView: { ...preliminary },
	};
	throws(
		() => renderAgentHeader(source, context, (header) => extractModelLevel(header, preliminary)),
		/header model depends on `model@`/,
		"model oscillation not rejected",
	);
});

scenario("when_agent_file_with_bom_and_crlf_then_same_two_stage_render", async () => {
	const plain = "---\nmodel: {{[role@]}}\n---\nBody {{[role@]}}\n";
	const withBom = "\uFEFF" + plain.replace(/\n/g, "\r\n");
	const preliminary = { model: "prelim/model", level: "low" };
	const context = {
		agentName: "foo",
		variables: { role: ["a", "b"] },
		partials: PARTIALS,
		parentView: {},
		subagentView: { role: "b", ...preliminary },
	};
	const extract = (header) => extractModelLevel(header, preliminary);
	const bomHeader = renderAgentHeader(withBom, context, extract);
	assertEqual(bomHeader.header, "---\nmodel: b\n---", "header with BOM/CRLF not rendered");
	assertEqual(bomHeader, renderAgentHeader(plain, context, extract), "header with BOM/CRLF differs");
	assertEqual(bomHeader.model, "b", "model with BOM/CRLF");
	assertEqual(renderAgentBody(withBom, context), "\nBody b\n", "body with BOM/CRLF not rendered");
	assertEqual(renderAgentBody(withBom, context), renderAgentBody(plain, context), "body with BOM/CRLF differs");
});

scenario("when_dynamic_partial_with_subagent_value_then_rendered", async () => {
	const source = '{{> (concat "roles/" [role@] ".md")}}';
	const context = {
		agentName: "foo",
		variables: { role: ["a", "b"] },
		partials: PARTIALS,
		parentView: {},
		subagentView: { role: "b" },
	};
	assertEqual(renderAgentBody(source, context), "Role B", "dynamic partial did not resolve the @ value");
	const lintResult = lintTemplate(source, {
		variables: { role: ["a", "b"] },
		partials: PARTIALS,
		agentName: "foo",
	});
	assertEqual(lintResult.problem, null, "lint rejected the @ segment of the dynamic partial");
});

/** Source tree: agent and project directories under a shared temp root. */
async function withTempTree(run) {
	return withTempDir(async (root) => {
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		const write = (relativePath, text) => {
			const path = join(root, relativePath);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
			return path;
		};
		return run({ root, agentDir, projectDir, write });
	});
}

/** Mini frontmatter parser for the zone B seam: flat `key: value`, true/false. */
function simpleHeaderParser(text) {
	if (!text.startsWith("---")) return {};
	const end = text.indexOf("\n---", 3);
	if (end === -1) throw new Error("frontmatter not closed");
	const parsed = {};
	for (const line of text.slice(4, end).split("\n")) {
		if (line.trim() === "") continue;
		const separator = line.indexOf(": ");
		if (separator === -1) throw new Error(`frontmatter line does not parse: ${line}`);
		const key = line.slice(0, separator).trim();
		const raw = line.slice(separator + 2).trim();
		parsed[key] = raw === "true" ? true : raw === "false" ? false : raw;
	}
	return parsed;
}

/** Session host for scenarios: model/level fixed, warnings collected. */
function sessionHost(warnings, model = "deepseek/flash", level = "max", extra = {}) {
	return {
		model,
		level,
		systemPrompt: "",
		sessionName: undefined,
		overrides: {},
		warn: (message) => warnings.push(message),
		...extra,
	};
}

/** Executor forbidden in static scenarios: no shell expected. */
const noShell = async () => {
	throw new Error("shell command was not expected");
};

/** Empty home directory: `~/.agents` roots do not depend on the dev machine. */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "templates-home-"));
process.on("exit", () => {
	try {
		rmSync(EMPTY_HOME, { recursive: true, force: true });
	} catch {
		// The directory is already removed.
	}
});

/** Scenario session: isolated home and environment stubs by default. */
function makeSession(options) {
	return new TemplateSession({
		env: {},
		execute: noShell,
		homeDir: EMPTY_HOME,
		parseHeader: simpleHeaderParser,
		...options,
	});
}

scenario("when_lock_reentrant_then_depth_counted", async () => {
	await withTempTree(async ({ write }) => {
		const target = write("target.md", "source text");
		const outer = await acquireLock(target, { scope: "s1" });
		assert(outer !== null, "lock not acquired");
		const inner = await acquireLock(target, { scope: "s1" });
		assertEqual(inner?.token, outer.token, "re-entry gave a different token");
		assert(ownsLock(outer), "ownership not confirmed");
		releaseLock(inner);
		assert(existsSync(`${target}.lock`), "inner release removed the lock");
		releaseLock(outer);
		assert(!existsSync(`${target}.lock`), "final release did not remove the lock");
	});
});

scenario("when_lock_scopes_differ_then_depth_not_shared", async () => {
	await withTempTree(async ({ write }) => {
		const target = write("target.md", "text");
		const first = await acquireLock(target, { scope: "parent" });
		assert(first !== null, "the first scope did not acquire the lock");
		const second = await acquireLock(target, { scope: "child", waitMs: 60 });
		assertEqual(second, null, "another scope entered a foreign lock");
		releaseLock(first);
		assert(!existsSync(`${target}.lock`), "own lock not released");
	});
});

scenario("when_lock_own_marker_stale_then_reacquired", async () => {
	await withTempTree(async ({ write }) => {
		const target = write("target.md", "text");
		const first = await acquireLock(target, { scope: "s1" });
		assert(first !== null, "lock not acquired");
		// This scope's lock was taken over by a foreign owner and is stale: the old token is dead.
		writeFileSync(
			join(`${target}.lock`, "owner.json"),
			JSON.stringify({ token: "foreign", pid: 1, at: Date.now() - LOCK_TTL_MS - 1000 }),
		);
		const second = await acquireLock(target, { scope: "s1" });
		assert(second !== null, "a stale taken-over lock was not reacquired");
		assert(second.token !== first.token, "a dead token was issued");
		assert(ownsLock(second), "ownership not confirmed");
		releaseLock(first);
		assert(existsSync(`${target}.lock`), "a dead token released a live lock");
		releaseLock(second);
		assert(!existsSync(`${target}.lock`), "the reacquired lock was not released");
	});
});

scenario("when_owner_marker_foreign_then_release_keeps_lock", async () => {
	await withTempTree(async ({ write }) => {
		const target = write("target.md", "session text");
		const handle = await acquireLock(target, { scope: "s1" });
		assert(handle !== null, "lock not acquired");
		writeFileSync(join(`${target}.lock`, "owner.json"), JSON.stringify({ token: "foreign", pid: 1, at: Date.now() }));
		assertEqual(writeTargetUnderLock(handle, "mine"), "lost", "write succeeded without ownership");
		assertEqual(readFileSync(target, "utf-8"), "session text", "target file written without ownership");
		releaseLock(handle);
		assert(existsSync(`${target}.lock`), "foreign lock released");
		rmSync(`${target}.lock`, { recursive: true, force: true });
	});
});

scenario("when_lock_stale_then_taken_over", async () => {
	await withTempTree(async ({ write }) => {
		const target = write("target.md", "text");
		mkdirSync(`${target}.lock`);
		writeFileSync(
			join(`${target}.lock`, "owner.json"),
			JSON.stringify({ token: "stale", pid: 1, at: Date.now() - LOCK_TTL_MS - 1000 }),
		);
		const handle = await acquireLock(target, { scope: "s1" });
		assert(handle !== null, "stale lock not acquired");
		assert(handle.token !== "stale", "token remained foreign");
		assert(ownsLock(handle), "confirmed ownership did not happen");
		releaseLock(handle);
		assert(!existsSync(`${target}.lock`), "own lock not released");
	});
});

scenario("when_lock_held_fresh_then_acquire_waits", async () => {
	await withTempTree(async ({ write }) => {
		const target = write("target.md", "text");
		mkdirSync(`${target}.lock`);
		writeFileSync(join(`${target}.lock`, "owner.json"), JSON.stringify({ token: "foreign", pid: 1, at: Date.now() }));
		const handle = await acquireLock(target, { waitMs: 60, scope: "s1" });
		assertEqual(handle, null, "a fresh foreign lock did not block acquisition");
		rmSync(`${target}.lock`, { recursive: true, force: true });
	});
});

scenario("when_target_written_under_lock_then_only_changes", async () => {
	await withTempTree(async ({ write }) => {
		const target = write("target.md", "previous");
		const handle = await acquireLock(target, { scope: "s1" });
		assert(handle !== null, "lock not acquired");
		assertEqual(writeTargetUnderLock(handle, "previous"), "unchanged", "matching text rewritten");
		assertEqual(writeTargetUnderLock(handle, "new"), "written", "differing text not written");
		assertEqual(readFileSync(target, "utf-8"), "new");
		releaseLock(handle);
	});
});

scenario("when_target_missing_then_write_creates", async () => {
	await withTempTree(async ({ root }) => {
		const target = join(root, "new.md");
		const handle = await acquireLock(target, { scope: "s1" });
		assert(handle !== null, "lock not acquired");
		assertEqual(writeTargetUnderLock(handle, "created"), "written", "missing target file not written");
		assertEqual(readFileSync(target, "utf-8"), "created");
		releaseLock(handle);
	});
});

scenario("when_sources_discovered_then_pairs_of_agent_and_project", async () => {
	await withTempTree(async ({ root, agentDir, projectDir, write }) => {
		write("AGENTS.md.template", "cwd ancestor");
		write("agent/AGENTS.md.template", "global");
		write("agent/skills/x/SKILL.md.template", "skill");
		write("agent/skills/x/reference.txt", "not a template");
		write("agent/prompts/p.md.template", "prompt");
		write("agent/agents/foo.md.template", "agent");
		write("project/.pi/SYSTEM.md.template", "project system");
		write("project/.pi/skills/s/SKILL.md.template", "project skill");
		const kinds = new Map(discoverSources(agentDir, projectDir).map((source) => [source.target, source.kind]));
		assertEqual(kinds.get(join(root, "AGENTS.md")), "context", "cwd ancestor not in the sources");
		assertEqual(kinds.get(join(agentDir, "AGENTS.md")), "context");
		assertEqual(kinds.get(join(agentDir, "skills", "x", "SKILL.md")), "skill");
		assertEqual(kinds.get(join(agentDir, "prompts", "p.md")), "prompt");
		assertEqual(kinds.get(join(agentDir, "agents", "foo.md")), "agent");
		assertEqual(kinds.get(join(projectDir, ".pi", "SYSTEM.md")), "system");
		assertEqual(kinds.get(join(projectDir, ".pi", "skills", "s", "SKILL.md")), "skill");
		assert(!kinds.has(join(agentDir, "skills", "x", "reference.txt")), "non-template file got into the sources");
	});
});

scenario("when_include_name_then_resolved_on_disk", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/modes/plan.md.template", "Plan source");
		write("agent/modes/other.md", "Plain other");
		write("agent/modes/both.md.template", "Source preferred");
		write("agent/modes/both.md", "Plain ignored");
		write("project/.pi/modes/proj.md.template", "Project mode");
		const partials = createPartialResolver(agentDir, projectDir);
		assertEqual(partials.exists("modes/plan.md"), true, "an include from an arbitrary directory was not found");
		assertEqual(partials.read("modes/plan.md"), "Plan source", "the source text was not read");
		assertEqual(partials.read("modes/other.md"), "Plain other", "an include without a source was not found");
		assertEqual(partials.read("modes/both.md"), "Source preferred", "the source was not preferred over the plain file");
		assertEqual(partials.read(".pi/modes/proj.md"), "Project mode", "the .pi/ name was not resolved from the project root");
		assertEqual(partials.exists("modes/ghost.md"), false, "a missing include reported as existing");
		assertEqual(partials.read("modes/ghost.md"), undefined, "a missing include produced text");
		assertEqual(partials.exists("../escape.md"), false, "a name escaping the root was resolved");
		assertEqual(partials.exists("modes"), false, "a directory was taken for an include");
		// Every read (including a failed one) tracks both candidates: the session
		// stamps them, so an edit, appearance or removal marks the context stale.
		assertEqual(
			[...partials.paths].sort(),
			[
				join(agentDir, "modes", "plan.md.template"),
				join(agentDir, "modes", "plan.md"),
				join(agentDir, "modes", "other.md.template"),
				join(agentDir, "modes", "other.md"),
				join(agentDir, "modes", "both.md.template"),
				join(agentDir, "modes", "both.md"),
				join(agentDir, "modes", "ghost.md.template"),
				join(agentDir, "modes", "ghost.md"),
				join(projectDir, ".pi", "modes", "proj.md.template"),
				join(projectDir, ".pi", "modes", "proj.md"),
			].sort(),
			"the candidate pair of a read include was not tracked",
		);
		// A file present but unreadable is an exception naming the include.
		write("agent/modes/locked.md", "locked");
		chmodSync(join(agentDir, "modes", "locked.md"), 0o000);
		try {
			throws(() => partials.read("modes/locked.md"), /partial "modes\/locked.md" cannot be read/);
		} finally {
			chmodSync(join(agentDir, "modes", "locked.md"), 0o644);
		}
	});
});

scenario("when_source_edited_then_stamps_differ", async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "x.md");
		writeFileSync(path, "one");
		const before = sourceStamps([path]);
		assertEqual(stampsDiffer(before, sourceStamps([path])), false, "matching stamps differ");
		writeFileSync(path, "other text");
		assertEqual(stampsDiffer(before, sourceStamps([path])), true, "source edit not detected");
		rmSync(path);
		assertEqual(stampsDiffer(before, sourceStamps([path])), true, "source removal not detected");
	});
});

scenario("when_versions_diverge_then_stale", async () => {
	const versions = new ContextVersions();
	assertEqual(versions.stale(), false, "empty versions considered differing");
	versions.setCurrent({ texts: { "/a": "1" }, view: {} });
	assertEqual(versions.stale(), true, "missing applied version not detected");
	versions.applyCurrent();
	assertEqual(versions.stale(), false, "apply did not align versions");
	versions.setCurrent({ texts: { "/a": "2" }, view: {} });
	assertEqual(versions.stale(), true, "current version does not differ from applied");
	versions.setCurrent({ texts: { "/a": "1" }, view: {} });
	assertEqual(versions.stale(), false, "matching versions considered differing");
});

scenario("when_sources_rendered_then_view_applied", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/AGENTS.md.template", "Hello {{who}}\n{{> roles/a.md}}");
		write("agent/roles/a.md", "Role {{who}}");
		write("agent/skills/x/SKILL.md.template", "---\ndescription: Skill {{who}}\n---\nbody");
		write(
			"agent/agents/foo.md.template",
			"---\nname: foo\ndescription: d\nmodel: {{[model@]}}\n---\nAgent {{who}} role {{[role@]}}",
		);
		const sources = discoverSources(agentDir, projectDir);
		const report = await renderSources(
			sources,
			{
				view: { who: "world", model: "sess/m", level: "high" },
				variables: { who: undefined, role: undefined, model: undefined, level: undefined },
				partials: createPartialResolver(agentDir, projectDir),
				parseHeader: simpleHeaderParser,
				subagentView: () => ({
					parentView: { who: "world" },
					subagentView: { model: "sess/m", level: "high", role: "r" },
					preliminary: { model: "sess/m", level: "high" },
				}),
			},
			() => undefined,
		);
		assertEqual(report.problems, [], "legal templates produced problems");
		assertEqual(report.warnings, []);
		assertEqual(report.texts[join(agentDir, "AGENTS.md")], "Hello world\nRole world");
		const agentText = report.texts[join(agentDir, "agents", "foo.md")];
		assert(agentText.includes("model: sess/m"), "agent header did not get the preliminary model");
		assert(agentText.includes("Agent world role r"), "agent body did not get the child view");
		const skillText = report.texts[join(agentDir, "skills", "x", "SKILL.md")];
		assert(skillText.startsWith("---\ndescription: Skill world\n---"), "skill frontmatter not rendered");
	});
});

scenario("when_source_render_fails_then_previous_text_kept", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/AGENTS.md.template", "Context");
		write("agent/prompts/bad.md.template", "{{> missing.md}}");
		write("agent/prompts/br.md.template", "---\ndescription without a colon\n---\nbody");
		const badTarget = join(agentDir, "prompts", "bad.md");
		const brokenTarget = join(agentDir, "prompts", "br.md");
		const sources = discoverSources(agentDir, projectDir);
		const report = await renderSources(
			sources,
			{
				view: {},
				variables: {},
				partials: createPartialResolver(agentDir, projectDir),
				parseHeader: simpleHeaderParser,
				subagentView: () => ({ parentView: {}, subagentView: {}, preliminary: { model: "m", level: "low" } }),
			},
			(target) => (target === badTarget ? "previous bad" : target === brokenTarget ? "previous br" : undefined),
		);
		assertEqual(report.problems.length >= 2, true, "render failure count did not match");
		assert(
			report.problems.some((problem) => problem.includes("bad.md.template")),
			"failure on a missing partial not named",
		);
		assert(
			report.problems.some((problem) => problem.includes("br.md.template")),
			"failure on broken frontmatter not named",
		);
		assertEqual(report.texts[badTarget], "previous bad", "target file without a partial did not keep the previous success");
		assertEqual(report.texts[brokenTarget], "previous br", "broken frontmatter rewrote the target file");
		assertEqual(report.texts[join(agentDir, "AGENTS.md")], "Context");
	});
});

scenario("when_agent_file_rendered_then_header_facts_used", async () => {
	const source =
		"---\nname: foo\ndescription: d\nmodel: actual/m\nthinking: low\n---\nModel {{[model@]}}, level {{[level@]}}, role {{[role@]}}";
	const result = renderAgentFile(source, {
		agentName: "foo",
		parentView: { who: "world" },
		subagentView: { model: "spawn/m", level: "medium", role: "r" },
		variables: { role: undefined },
		partials: NO_PARTIALS,
		preliminary: { model: "spawn/m", level: "medium" },
		parseHeader: simpleHeaderParser,
	});
	assertEqual(result.model, "actual/m", "actual model not taken from the header");
	assertEqual(result.level, "low", "actual level not taken from the header");
	assert(result.text.includes("model: actual/m"), "header not re-rendered with the actual model");
	assert(result.text.includes("Model actual/m, level low, role r"), "body did not get actual values");
});

scenario("when_agent_header_without_model_then_preliminary_kept", async () => {
	const source = "---\nname: foo\ndescription: d\n---\nBody {{[model@]}}";
	const result = renderAgentFile(source, {
		agentName: "foo",
		parentView: {},
		subagentView: { model: "spawn/m", level: "medium" },
		variables: {},
		partials: NO_PARTIALS,
		preliminary: { model: "spawn/m", level: "medium" },
		parseHeader: simpleHeaderParser,
	});
	assertEqual(result.model, "spawn/m");
	assertEqual(result.level, "medium");
	assert(result.text.includes("Body spawn/m"), "preliminary value did not reach the body");
});

scenario("when_agent_header_invalid_then_render_fails", async () => {
	// thinking: true is silently skipped by the consumer ("no level set") — the preliminary one remains.
	const lenient = renderAgentFile("---\nname: foo\nthinking: true\n---\nLevel {{[level@]}}", {
		agentName: "foo",
		parentView: {},
		subagentView: { model: "m", level: "low" },
		variables: {},
		partials: NO_PARTIALS,
		preliminary: { model: "m", level: "low" },
		parseHeader: simpleHeaderParser,
	});
	assertEqual(lenient.level, "low", "thinking: true not given to the preliminary value");
	assert(lenient.text.includes("Level low"), "body did not get the preliminary level");
	throws(
		() =>
			renderAgentFile("---\nbroken\n---\nbody", {
				agentName: "foo",
				parentView: {},
				subagentView: { model: "m", level: "low" },
				variables: {},
				partials: NO_PARTIALS,
				preliminary: { model: "m", level: "low" },
				parseHeader: simpleHeaderParser,
			}),
		"broken frontmatter not rejected",
	);
	assertEqual(agentHeaderFacts({ thinking: false }), { level: "off" });
	assertEqual(agentHeaderFacts({ thinking: true }), {}, "thinking: true produced a level");
	assertEqual(agentHeaderFacts({ thinking: "weird" }), {}, "unknown level not skipped");
	assertEqual(agentHeaderFacts({}), {});
});

scenario("when_agent_header_model_suffix_then_level_split", async () => {
	assertEqual(agentHeaderFacts({ model: "p/q:high" }), { model: "p/q", level: "high" });
	assertEqual(
		agentHeaderFacts({ model: "p/q", thinking: "low" }),
		{ model: "p/q", level: "low" },
		"thinking not applied without a suffix",
	);
	assertEqual(
		agentHeaderFacts({ model: "p/q:high", thinking: "low" }),
		{ model: "p/q", level: "high" },
		"model suffix not stronger than thinking",
	);
});

scenario("when_agent_parameter_explicit_then_it_wins_over_header", async () => {
	const source = "---\nname: foo\ndescription: d\nmodel: x/y\nthinking: low\n---\nModel {{[model@]}}, level {{[level@]}}";
	const explicit = renderAgentFile(source, {
		agentName: "foo",
		parentView: {},
		subagentView: { model: "p/q", level: "high" },
		variables: {},
		partials: NO_PARTIALS,
		preliminary: { model: "p/q", level: "high", explicitModel: true, explicitLevel: true },
		parseHeader: simpleHeaderParser,
	});
	assertEqual(explicit.model, "p/q", "explicit model did not override the header");
	assertEqual(explicit.level, "high", "explicit level did not override the header");
	assert(explicit.text.includes("Model p/q, level high"), "body did not get explicit values");

	const explicitModelOnly = renderAgentFile(source, {
		agentName: "foo",
		parentView: {},
		subagentView: { model: "p/q", level: "medium" },
		variables: {},
		partials: NO_PARTIALS,
		preliminary: { model: "p/q", level: "medium", explicitModel: true },
		parseHeader: simpleHeaderParser,
	});
	assertEqual(explicitModelOnly.model, "p/q");
	assertEqual(explicitModelOnly.level, "low", "header level lost with an explicit model without a suffix");
});

scenario("when_identity_channels_then_agent_name", async () => {
	assertEqual(agentNameFromPrompt('before\n<active_agent name="foo"/>\nafter'), "foo");
	assertEqual(agentNameFromPrompt("<active_agent name=\"bad name\"/>"), undefined, "invalid name passed");
	assertEqual(agentNameFromPrompt("without a tag"), undefined);
	assertEqual(agentNameFromSessionName("foo"), "foo");
	assertEqual(agentNameFromSessionName("foo: do the task"), "foo");
	assertEqual(agentNameFromSessionName("task without name"), undefined, "formless name parsed silently");
	assertEqual(agentNameFromSessionName("  "), undefined);
	// intercom form: subagent-<agent>-<uuid>[-N]
	assertEqual(
		agentNameFromSessionName("subagent-code-reviewer-01a141d2-b7b2-7700-b0e5-78ed039fee65"),
		"code-reviewer",
		"intercom form not parsed",
	);
	assertEqual(
		agentNameFromSessionName("subagent-foo-deadbeef-1234-5678-9abc-def012345678-2"),
		"foo",
		"step index broke intercom form parsing",
	);
	assertEqual(agentNameFromSessionName("agent"), undefined, "literal agent accepted as a name");
	assertEqual(agentNameFromSessionName("agent: task"), undefined, "literal agent accepted as a name");
});

scenario("when_spawn_input_traversed_then_agent_targets", async () => {
	const targets = collectSpawnTargets({
		agent: "a",
		model: "x/y:high",
		tasks: [{ agent: "b" }],
		chain: [{ parallel: [{ agent: "c", model: "p/q" }], model: "z/w" }],
	});
	assertEqual(targets, [
		{ name: "a", model: "x/y:high" },
		{ name: "b", model: "x/y:high" },
		{ name: "c", model: "p/q" },
	]);
	assertEqual(collectSpawnTargets({ workflow: "w" }), []);
});

scenario("when_session_started_then_targets_written_and_delivered", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "Hello {{who}}");
		const warnings = [];
		const host = sessionHost(warnings);
		const session = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await session.start(host, "startup");
		assert(session.ready(), "session not ready after start");
		assertEqual(session.isStale(), false, "start did not align versions");
		const target = join(agentDir, "AGENTS.md");
		assertEqual(readFileSync(target, "utf-8"), "Hello world", "start did not write the target file");

		await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		write("agent/AGENTS.md.template", "Bye {{who}}!");
		const appliedOptions = { contextFiles: [{ path: target, content: "Hello world" }] };
		await session.beforeAgentStart({ systemPromptOptions: appliedOptions }, host);
		assertEqual(session.isStale(), true, "source edit did not mark the context stale");
		assertEqual(readFileSync(target, "utf-8"), "Hello world", "edit applied automatically");
		assertEqual(appliedOptions.contextFiles[0].content, "Hello world", "section did not keep the applied version");

		assertEqual(session.apply(), true, "apply button failed");
		const freshOptions = { contextFiles: [{ path: target, content: "Hello world" }] };
		await session.beforeAgentStart({ systemPromptOptions: freshOptions }, host);
		assertEqual(readFileSync(target, "utf-8"), "Bye world!", "apply did not write the target file");
		assertEqual(freshOptions.contextFiles[0].content, "Bye world!", "apply not delivered to the sections");
		assertEqual(session.isStale(), false, "versions differ after apply");
		session.shutdown("quit");
	});
});

scenario("when_included_file_changed_then_context_stale", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "Hello {{> roles/a.md}}");
		write("agent/roles/a.md", "Role {{who}}");
		write("agent/roles/unused.md", "Unused");
		const target = join(agentDir, "AGENTS.md");
		const warnings = [];
		const host = sessionHost(warnings);
		const session = makeSession({ agentDir, projectDir, parseHeader: simpleHeaderParser, env: {}, execute: noShell });
		await session.start(host, "startup");
		assertEqual(readFileSync(target, "utf-8"), "Hello Role world", "the include was not rendered");
		await session.beforeAgentStart({ systemPromptOptions: {} }, host);
		assertEqual(session.isStale(), false, "a quiet turn marked the context stale");

		await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		write("agent/roles/a.md", "Changed {{who}}");
		await session.beforeAgentStart({ systemPromptOptions: {} }, host);
		assertEqual(session.isStale(), true, "an edit of an included file did not mark the context stale");
		assertEqual(readFileSync(target, "utf-8"), "Hello Role world", "the include edit was applied automatically");

		// The appearance of the source `X.template` wins over the plain file.
		await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		write("agent/roles/a.md.template", "Source {{who}}");
		await session.beforeAgentStart({ systemPromptOptions: {} }, host);
		assertEqual(session.isStale(), true, "the appearance of X.template did not mark the context stale");
		assertEqual(session.apply(), true, "apply failed");
		await session.beforeAgentStart({ systemPromptOptions: {} }, host);
		assertEqual(session.isStale(), false, "apply did not align the versions");
		assertEqual(readFileSync(target, "utf-8"), "Hello Source world", "the source was not preferred after appearing");

		// A file that did not get into the last render does not affect staleness.
		await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		write("agent/roles/unused.md", "Changed unused");
		await session.beforeAgentStart({ systemPromptOptions: {} }, host);
		assertEqual(session.isStale(), false, "a file that was not included marked the context stale");
		session.shutdown("quit");
	});
});

scenario("when_dynamic_include_value_missing_then_start_warns", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { role: { values: ["a", "b"], initial: "a" } } }));
		write("agent/AGENTS.md.template", '{{> (concat "roles/" role ".md")}}');
		write("agent/roles/a.md", "Role A");
		const warnings = [];
		const session = makeSession({ agentDir, projectDir, parseHeader: simpleHeaderParser, env: {}, execute: noShell });
		await session.start(sessionHost(warnings), "startup");
		assert(
			warnings.some((message) => message.includes('dynamic partial: name "roles/b.md" not found')),
			"a missing value of a dynamic include was not warned about at start",
		);
		assertEqual(readFileSync(join(agentDir, "AGENTS.md"), "utf-8"), "Role A", "the selected value did not render");
		session.shutdown("quit");
	});
});

scenario("when_selected_dynamic_include_missing_then_appearance_heals", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { role: { values: ["a", "b"], initial: "b" } } }));
		write("agent/AGENTS.md.template", '{{> (concat "roles/" role ".md")}}');
		write("agent/roles/a.md", "Role A");
		const target = join(agentDir, "AGENTS.md");
		const warnings = [];
		const host = sessionHost(warnings);
		const session = makeSession({ agentDir, projectDir, parseHeader: simpleHeaderParser, env: {}, execute: noShell });
		await session.start(host, "startup");
		assert(
			warnings.some((message) => message.includes('partial "roles/b.md" not found')),
			"a missing selected include did not name the value",
		);
		assertEqual(existsSync(target), false, "a failed source wrote a target file");
		await session.beforeAgentStart({ systemPromptOptions: {} }, host);

		write("agent/roles/b.md", "Role B");
		await session.beforeAgentStart({ systemPromptOptions: {} }, host);
		assertEqual(session.isStale(), true, "the appearance of the missing include did not mark the context stale");
		assertEqual(session.apply(), true, "apply failed");
		assertEqual(readFileSync(target, "utf-8"), "Role B", "the healed include did not reach the target");
		session.shutdown("quit");
	});
});

scenario("when_session_reloaded_then_targets_are_applied", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "New {{who}}");
		const target = write("agent/AGENTS.md", "Foreign");
		const warnings = [];
		const host = sessionHost(warnings);
		const session = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await session.start(host, "reload");
		assertEqual(readFileSync(target, "utf-8"), "Foreign", "reload rewrote the target file");
		assertEqual(session.isStale(), true, "current version did not lag after reload");
		const options = { contextFiles: [{ path: target, content: "Foreign" }] };
		await session.beforeAgentStart({ systemPromptOptions: options }, host);
		assertEqual(options.contextFiles[0].content, "Foreign", "applied version replaced by the current one");
		session.shutdown("quit");
	});
});

scenario("when_read_bracket_then_target_gets_applied_variant", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "Hello {{who}}");
		const target = join(agentDir, "AGENTS.md");
		const warnings = [];
		const session = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await session.start(sessionHost(warnings), "startup");
		writeFileSync(target, "foreign variant");
		const bracket = await session.openReadBracket(target);
		assert(bracket !== null, "read bracket not acquired");
		assertEqual(readFileSync(target, "utf-8"), "Hello world", "the read got a non-applied variant");
		session.releaseBracket(bracket);
		assert(!existsSync(`${target}.lock`), "read lock not released");
		session.shutdown("quit");
	});
});

scenario("when_spawn_bracket_then_agent_target_rendered", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write(
			"agent/template.json",
			JSON.stringify({ vars: { who: { initial: "world" }, role: { initial: "r" } } }),
		);
		write("agent/agents/foo.md.template", "---\nname: foo\ndescription: d\n---\nAgent {{who}} role {{[role@]}}");
		const target = join(agentDir, "agents", "foo.md");
		const warnings = [];
		const session = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await session.start(sessionHost(warnings), "startup");
		const brackets = await session.openSpawnBracket({ agent: "foo" });
		assertEqual(brackets.length, 1, "spawn bracket did not cover the agent file");
		assertEqual(readFileSync(target, "utf-8").includes("Agent world role r"), true, "agent target file not rendered");
		for (const bracket of brackets) session.releaseBracket(bracket);
		assert(!existsSync(`${target}.lock`), "spawn lock not released");
		session.shutdown("quit");
	});
});

/** Session variable change and recompute: explicit actions without applying. */
scenario("when_session_variable_changed_then_stale_without_apply", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "Hello {{who}}");
		const target = join(agentDir, "AGENTS.md");
		const warnings = [];
		const session = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await session.start(sessionHost(warnings), "startup");
		const changed = await session.setVariable("who", "sun");
		assertEqual(changed, { ok: true }, "session variable change failed");
		assertEqual(readFileSync(target, "utf-8"), "Hello world", "variable change applied the context");
		assertEqual(session.isStale(), true, "variable change did not mark the context stale");
		const implicit = await session.setVariable("model", "p/m");
		assertEqual(implicit.ok, false, "implicit variable overridden");
		session.shutdown("quit");
	});
});

/** Delivery: no target files when pi loaded — our records are added, not only replaced. */
scenario("when_targets_missing_at_load_then_sections_added", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/SYSTEM.md.template", "System {{who}}");
		write("agent/skills/x/SKILL.md.template", "---\nname: x\ndescription: Skill {{who}}\n---\nbody");
		write("project/AGENTS.md.template", "Project {{who}}");
		const warnings = [];
		const session = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await session.start(sessionHost(warnings), "startup");
		const options = {};
		await session.beforeAgentStart({ systemPromptOptions: options }, sessionHost(warnings));
		assertEqual(options.contextFiles?.length, 1, "context file not added");
		assertEqual(options.contextFiles[0].path, join(projectDir, "AGENTS.md"));
		assertEqual(options.contextFiles[0].content, "Project world");
		assertEqual(options.skills?.length, 1, "skill not added");
		assertEqual(options.skills[0].name, "x");
		assertEqual(options.skills[0].description, "Skill world");
		assertEqual(options.skills[0].baseDir, join(agentDir, "skills", "x"));
		assertEqual(options.skills[0].sourceInfo.scope, "user");
		assertEqual(options.customPrompt, "System world", "SYSTEM.md not added");
		session.shutdown("quit");
	});
});

/** Mixed case: foreign records untouched, ours replaced, missing ours added. */
scenario("when_foreign_entries_then_mixed_delivery", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/skills/x/SKILL.md.template", "---\nname: x\ndescription: Skill {{who}}\n---\nbody");
		write("agent/agents/foo.md.template", "---\nname: foo\ndescription: d\n---\nbody");
		write("project/AGENTS.md.template", "Project {{who}}");
		const warnings = [];
		const session = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await session.start(sessionHost(warnings), "startup");
		const foreignSkill = {
			name: "foreign",
			description: "old foreign",
			filePath: "/foreign/SKILL.md",
			baseDir: "/foreign",
			sourceInfo: { path: "/foreign/SKILL.md", source: "local", scope: "temporary", origin: "top-level" },
			disableModelInvocation: false,
		};
		const options = {
			contextFiles: [{ path: "/foreign/AGENTS.md", content: "foreign context" }],
			skills: [foreignSkill, { ...foreignSkill, name: "x", filePath: join(agentDir, "skills", "x", "SKILL.md") }],
		};
		await session.beforeAgentStart({ systemPromptOptions: options }, sessionHost(warnings));
		assertEqual(options.contextFiles[0], { path: "/foreign/AGENTS.md", content: "foreign context" }, "foreign context rewritten");
		assertEqual(options.contextFiles.length, 2, "our context not added next to the foreign one");
		assertEqual(options.contextFiles[1].content, "Project world");
		assertEqual(options.skills[0].description, "old foreign", "foreign skill rewritten");
		assertEqual(options.skills[1].description, "Skill world", "our skill description not replaced");
		assertEqual(options.skills.length, 2, "extra skill added");
		session.shutdown("quit");
	});
});

/** `/reload`: the old session writes the current version before pi re-reads target files. */
scenario("when_reload_shutdown_then_current_written", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "Hello {{who}}");
		const target = join(agentDir, "AGENTS.md");
		const warnings = [];
		const session = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await session.start(sessionHost(warnings), "startup");
		await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		write("agent/AGENTS.md.template", "Bye {{who}}!");
		await session.beforeAgentStart({ systemPromptOptions: {} }, sessionHost(warnings));
		assertEqual(readFileSync(target, "utf-8"), "Hello world", "edit applied before reload");
		session.shutdown("reload");
		assertEqual(readFileSync(target, "utf-8"), "Bye world!", "reload did not write the current version");
		const next = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await next.start(sessionHost(warnings), "reload");
		assertEqual(next.isStale(), false, "versions differ after reload");
		next.shutdown("quit");
	});
});

/** Fallback session name with the tag gone: `@` values in the current version. */
scenario("when_tag_missing_then_session_name_fallback", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { role: { values: ["a", "b"], initial: "a", "@": "b" } } }));
		write("agent/roles/a.md", "Role A");
		write("agent/roles/b.md", "Role B");
		write("agent/AGENTS.md.template", '{{> (concat "roles/" role ".md")}}');
		const target = join(agentDir, "AGENTS.md");
		const warnings = [];
		const session = makeSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
		});
		await session.start(sessionHost(warnings), "startup");
		assertEqual(readFileSync(target, "utf-8"), "Role A", "without the tag a non-machine value was applied");
		await session.onSessionName("foo: task", sessionHost(warnings));
		assertEqual(session.isStale(), true, "fallback name did not mark the context stale");
		assertEqual(readFileSync(target, "utf-8"), "Role A", "fallback name applied the context automatically");
		assert(warnings.some((message) => message.includes("active_agent")), "no loud warning about the missing tag");
		assertEqual(session.apply(), true);
		assertEqual(readFileSync(target, "utf-8"), "Role B", "apply did not give the subagent value");
		session.shutdown("quit");
	});
});

/** Consumer roots: `~/.agents` agents and `.agents/skills` skills. */
scenario("when_agents_roots_then_discovered", async () => {
	await withTempTree(async ({ root, agentDir, projectDir, write }) => {
		const homeDir = join(root, "home");
		write("home/.agents/foo.md.template", "home agent");
		write("home/.agents/skills/s/SKILL.md.template", "home skill");
		write("project/.agents/skills/p/SKILL.md.template", "ancestor skill");
		const problems = [];
		const kinds = new Map(
			discoverSources(agentDir, projectDir, { homeDir, problems }).map((source) => [source.target, source.kind]),
		);
		assertEqual(kinds.get(join(homeDir, ".agents", "foo.md")), "agent", "~/.agents not in the sources");
		assertEqual(
			kinds.get(join(homeDir, ".agents", "skills", "s", "SKILL.md")),
			"skill",
			"~/.agents/skills not in the sources",
		);
		assertEqual(
			kinds.get(join(projectDir, ".agents", "skills", "p", "SKILL.md")),
			"skill",
			"ancestor .agents/skills not in the sources",
		);
		assertEqual(problems, []);
	});
});

scenario("when_directory_unreadable_then_problem", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/skills/secret/SKILL.md.template", "secret");
		const secret = join(agentDir, "skills", "secret");
		chmodSync(secret, 0o000);
		try {
			const problems = [];
			discoverSources(agentDir, projectDir, { homeDir: EMPTY_HOME, problems });
			assert(
				problems.some((problem) => problem.includes("cannot be read")),
				"directory read error not in warnings",
			);
		} finally {
			chmodSync(secret, 0o755);
		}
	});
});

/** SYSTEM/APPEND: replacement by the pi-loaded text, miss warning, string inviolability. */
scenario("when_system_sections_then_replaced_or_warned", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/SYSTEM.md.template", "System {{who}}");
		write("agent/APPEND_SYSTEM.md.template", "Extra {{who}}");
		write("agent/SYSTEM.md", "FOREIGN SYSTEM");
		write("agent/APPEND_SYSTEM.md", "FOREIGN EXTRA");
		const warnings = [];
		const session = makeSession({ agentDir, projectDir });
		await session.start(sessionHost(warnings), "startup");
		const options = { customPrompt: "FOREIGN SYSTEM", appendSystemPrompt: "FOREIGN EXTRA" };
		await session.beforeAgentStart({ systemPromptOptions: options }, sessionHost(warnings));
		assertEqual(options.customPrompt, "System world", "SYSTEM not replaced by the pi-loaded text");
		assertEqual(options.appendSystemPrompt, "Extra world", "APPEND not replaced by the pi-loaded text");
		const changed = { customPrompt: "THIRD TEXT" };
		await session.beforeAgentStart({ systemPromptOptions: changed }, sessionHost(warnings));
		assertEqual(changed.customPrompt, "THIRD TEXT", "text changed after loading was rewritten");
		assert(
			warnings.some((message) => message.includes("text changed after pi loaded it")),
			"section change after loading not warned",
		);
		session.shutdown("quit");

		// Explicit SDK/CLI prompt: the string is not recognized as our target — a warned miss.
		const unknownWarnings = [];
		const unknownSession = makeSession({ agentDir, projectDir });
		await unknownSession.start(sessionHost(unknownWarnings), "startup");
		const unknown = { customPrompt: "UNKNOWN PROMPT" };
		await unknownSession.beforeAgentStart({ systemPromptOptions: unknown }, sessionHost(unknownWarnings));
		assertEqual(unknown.customPrompt, "UNKNOWN PROMPT", "unknown text rewritten");
		assert(
			unknownWarnings.some((message) => message.includes("not recognized as our target")),
			"miss of unknown string recognition not warned",
		);
		unknownSession.shutdown("quit");
	});
});

/** Child: a file SYSTEM is replaced by the source rule, a derived one never. */
scenario("when_child_section_then_source_rule", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/SYSTEM.md.template", "System {{who}}");
		const warnings = [];
		const childHost = sessionHost(warnings, "deepseek/flash", "max", {
			systemPrompt: '<active_agent name="foo"/>',
		});
		const session = makeSession({ agentDir, projectDir });
		await session.start(childHost, "startup");
		// Race: the child's pi read the old target file before another session wrote.
		const raced = { customPrompt: "OLD CHILD TARGET" };
		await session.beforeAgentStart({ systemPromptOptions: raced }, childHost);
		assertEqual(raced.customPrompt, "System world", "child did not replace the file SYSTEM by the source rule");
		const derived = { customPrompt: '<active_agent name="foo"/>\n\nSUPER-PROMPT' };
		await session.beforeAgentStart({ systemPromptOptions: derived }, childHost);
		assertEqual(
			derived.customPrompt,
			'<active_agent name="foo"/>\n\nSUPER-PROMPT',
			"child derived prompt rewritten",
		);
		session.shutdown("quit");
	});
});

/** Spawn: an explicit `model` (including `:level`) wins over the header; no parameter — the header. */
scenario("when_spawn_explicit_model_then_header_not_override", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: {} }));
		write(
			"agent/agents/foo.md.template",
			"---\nname: foo\ndescription: d\nmodel: x/y\nthinking: low\n---\n{{[model@]}}/{{[level@]}}",
		);
		const target = join(agentDir, "agents", "foo.md");
		const warnings = [];
		const session = makeSession({ agentDir, projectDir });
		await session.start(sessionHost(warnings), "startup");
		const explicit = await session.openSpawnBracket({ agent: "foo", model: "p/q:high" });
		assertEqual(explicit.length, 1, "spawn bracket did not cover the agent file");
		assertEqual(
			readFileSync(target, "utf-8").includes("p/q/high"),
			true,
			"explicit parameter did not override the header",
		);
		for (const bracket of explicit) session.releaseBracket(bracket);
		const defaults = await session.openSpawnBracket({ agent: "foo" });
		assertEqual(defaults.length, 1);
		assertEqual(readFileSync(target, "utf-8").includes("x/y/low"), true, "without a parameter the header not applied");
		for (const bracket of defaults) session.releaseBracket(bracket);
		session.shutdown("quit");
	});
});

/** Ownership loss in the read bracket: retry the re-render; twice — warn. */
scenario("when_read_bracket_lost_then_retried", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "Hello {{who}}");
		const target = join(agentDir, "AGENTS.md");
		const warnings = [];
		class LostOnceSession extends TemplateSession {
			constructor(options) {
				super(options);
				this.sabotage = 1;
			}
			async renderForApplied(source, preliminary) {
				const text = await super.renderForApplied(source, preliminary);
				if (this.sabotage > 0) {
					this.sabotage -= 1;
					writeFileSync(
						join(`${source.target}.lock`, "owner.json"),
						JSON.stringify({ token: "foreign", pid: 1, at: Date.now() - LOCK_TTL_MS - 1000 }),
					);
				}
				return text;
			}
		}
		const session = new LostOnceSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
			homeDir: EMPTY_HOME,
		});
		await session.start(sessionHost(warnings), "startup");
		writeFileSync(target, "foreign variant");
		const bracket = await session.openReadBracket(target);
		assert(bracket !== null, "retry after ownership loss did not happen");
		assertEqual(readFileSync(target, "utf-8"), "Hello world", "target file not re-rendered after retry");
		session.releaseBracket(bracket);
		session.shutdown("quit");
	});
});

scenario("when_read_bracket_lost_twice_then_warned", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "Hello {{who}}");
		const target = join(agentDir, "AGENTS.md");
		const warnings = [];
		class AlwaysLostSession extends TemplateSession {
			async renderForApplied(source, preliminary) {
				const text = await super.renderForApplied(source, preliminary);
				writeFileSync(
					join(`${source.target}.lock`, "owner.json"),
					JSON.stringify({ token: "foreign", pid: 1, at: Date.now() - LOCK_TTL_MS - 1000 }),
				);
				return text;
			}
		}
		const session = new AlwaysLostSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			execute: noShell,
			homeDir: EMPTY_HOME,
		});
		await session.start(sessionHost(warnings), "startup");
		const bracket = await session.openReadBracket(target);
		assertEqual(bracket, null, "exhausted retries did not stop the bracket");
		assert(
			warnings.some((message) => message.includes("ownership lost twice")),
			"exhausted retries not warned",
		);
		session.shutdown("quit");
	});
});

/** Recompute by explicit commands and value ages. */
/**
 * A model change re-renders the current version under the new values. The
 * context is compared by texts: with the same render the prompt already
 * equals a fresh render, the context is fresh — the per-variable rows show
 * which inputs changed.
 */
scenario("when_model_changed_then_context_fresh_by_text", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "Hello {{who}}");
		const session = new TemplateSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			homeDir: EMPTY_HOME,
			execute: noShell,
			now: () => 1000,
		});
		const warnings = [];
		await session.start(sessionHost(warnings), "startup");
		assertEqual(session.isStale(), false, "a fresh session is not stale");
		await session.onModelChanged(sessionHost(warnings, "deepseek/other", "max"));
		assertEqual(session.currentView().model, "deepseek/other", "the view did not take the new model");
		assertEqual(session.isStale(), false, "a model change with identical text marked the context stale");
		await session.onModelChanged(sessionHost(warnings, "deepseek/other", "max"));
		assertEqual(session.isStale(), false, "a repeated model event marked the context stale");
		session.shutdown("quit");
	});
});

scenario("when_session_recompute_then_values_and_ages", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write(
			"agent/template.json",
			JSON.stringify({ vars: { branch: { initial: { shell: "branch" } }, who: { initial: "world" } } }),
		);
		write("agent/AGENTS.md.template", "Branch {{branch}}, {{who}}");
		const calls = [];
		let clock = 1000;
		const execute = async (command) => {
			calls.push(command);
			return { code: 0, stdout: "main\n", stderr: "" };
		};
		const session = new TemplateSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			homeDir: EMPTY_HOME,
			execute,
			now: () => clock,
		});
		const warnings = [];
		await session.start(sessionHost(warnings), "startup");
		assertEqual(session.currentView().branch, "main", "computed value not in the view");
		assertEqual(session.computedAge("branch"), 0, "computed value age not tracked");
		assertEqual(session.computedAge("who"), undefined, "static variable got an age");
		clock = 5000;
		assertEqual(session.computedAge("branch"), 4000, "age does not grow");
		const denied = await session.setVariable("branch", "x");
		assertEqual(denied.ok, false, "computed variable overridden");
		const notComputed = await session.recompute("who");
		assertEqual(notComputed, { ok: false, problem: 'variable "who" is not computed — nothing to recompute' });
		const single = await session.recompute("branch");
		assertEqual(single.ok, true, "variable recompute failed");
		assertEqual(calls.filter((command) => command === "branch").length, 2, "shell command not re-run");
		const all = await session.recomputeAll();
		assertEqual(all.ok, true, "recompute all failed");
		assertEqual(calls.filter((command) => command === "branch").length, 3, "recomputeAll did not recompute computed");
		assertEqual(session.computedAge("branch"), 0, "age not reset after recompute");
		session.shutdown("quit");
	});
});

/** Derived variables follow the model without explicit recompute. */
scenario("when_model_changes_then_derived_follows", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write(
			"agent/template.json",
			JSON.stringify({ vars: { is_flash: { compute: 'in model "deepseek/flash" "a/b"' } } }),
		);
		write("agent/AGENTS.md.template", "flash {{is_flash}}");
		const session = new TemplateSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			homeDir: EMPTY_HOME,
			execute: noShell,
			now: () => 1000,
		});
		const warnings = [];
		await session.start(sessionHost(warnings), "startup");
		assertEqual(session.currentView().is_flash, "true", "the startup view is not derived");
		await session.onModelChanged(sessionHost(warnings, "deepseek/other", "max"));
		assertEqual(session.currentView().is_flash, "false", "the derived value did not follow the model change");
		session.shutdown("quit");
	});

	// The first-turn actual-model correction is a separate view change path.
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write(
			"agent/template.json",
			JSON.stringify({ vars: { is_flash: { compute: 'in model "deepseek/flash" "a/b"' } } }),
		);
		write("agent/AGENTS.md.template", "flash {{is_flash}}");
		const session = new TemplateSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			homeDir: EMPTY_HOME,
			execute: noShell,
			now: () => 1000,
		});
		const warnings = [];
		await session.start(sessionHost(warnings, "deepseek/other", "max"), "startup");
		assertEqual(session.currentView().is_flash, "false", "the startup view is not derived");
		await session.beforeAgentStart({ systemPromptOptions: {} }, sessionHost(warnings, "deepseek/flash", "max"));
		assertEqual(session.currentView().is_flash, "true", "the model correction did not re-derive");
		session.shutdown("quit");
	});
});

/** A derived variable is overridable and its dependents follow. */
scenario("when_derived_variable_set_then_override_and_dependents_follow", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write(
			"agent/template.json",
			JSON.stringify({
				vars: {
					is_flash: { compute: 'in model "a"' },
					is_dumb: { compute: 'or is_flash (eq level "off")' },
				},
			}),
		);
		write("agent/AGENTS.md.template", "flash {{is_flash}} dumb {{is_dumb}}");
		const session = new TemplateSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			homeDir: EMPTY_HOME,
			execute: noShell,
			now: () => 1000,
		});
		const warnings = [];
		await session.start(sessionHost(warnings, "a", "high"), "startup");
		assertEqual(session.currentView().is_dumb, "true", "the startup derived value");

		const denied = await session.setVariable("is_flash", "maybe");
		assert(!denied.ok, "a foreign value was accepted");
		assert(/boolean/.test(denied.problem ?? ""), `problem not named: ${denied.problem ?? ""}`);
		const refused = await session.recompute("is_flash");
		assertEqual(
			refused,
			{ ok: false, problem: 'variable "is_flash" is not computed — nothing to recompute' },
			"a derived variable was offered for recompute",
		);

		const applied = await session.setVariable("is_flash", "false");
		assert(applied.ok, `override failed: ${applied.problem ?? ""}`);
		assertEqual(session.currentView().is_flash, "false", "the override is not in the view");
		assertEqual(session.currentView().is_dumb, "false", "the dependent variable did not follow the override");
		session.shutdown("quit");
	});
});

/** Child views: `@` values win, the child's own model derives the rest. */
scenario("when_child_view_computed_then_derived_follows_child_model", async () => {
	const derived = config({
		is_flash: { compute: 'in model "a" "b"', subagentAny: "true" },
		child_flash: { compute: 'in model "a" "b"' },
	});
	const child = await computeView({
		config: derived,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "a", level: "low" },
		agentName: "foo",
		env: {},
		execute: noShell,
	});
	assertEqual(child.view.child_flash, "true", "the child model did not derive the value");
	assertEqual(child.view.is_flash, "true", "the @ value lost");

	const other = await computeView({
		config: derived,
		agentDir: AGENT_DIR,
		projectDir: PROJECT_DIR,
		implicit: { model: "c", level: "low" },
		agentName: "foo",
		env: {},
		execute: noShell,
	});
	assertEqual(other.view.child_flash, "false", "the child model did not derive the value");
	assertEqual(other.view.is_flash, "true", "the @ value did not win over the expression");

	const view = { model: "c", level: "low", is_flash: "true", child_flash: "true" };
	evaluateExpressions(derived, view, { agentName: "foo" });
	assertEqual(view.is_flash, "true", "the @ value did not survive re-derivation");
	assertEqual(view.child_flash, "false", "re-derivation ignored the model");
});

/** A project skill is added only with trust. */
scenario("when_project_skill_trust_then_added", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: {} }));
		write("project/.pi/skills/x/SKILL.md.template", "---\ndescription: Project skill\n---\nbody");
		const warnings = [];
		const untrusted = makeSession({ agentDir, projectDir });
		await untrusted.start(sessionHost(warnings), "startup");
		const denied = {};
		await untrusted.beforeAgentStart({ systemPromptOptions: denied }, sessionHost(warnings));
		assertEqual(denied.skills ?? [], [], "project skill added without trust");
		untrusted.shutdown("quit");
		const trustedHost = sessionHost(warnings, "deepseek/flash", "max", { projectTrusted: true });
		const trusted = makeSession({ agentDir, projectDir });
		await trusted.start(trustedHost, "startup");
		const allowed = {};
		await trusted.beforeAgentStart({ systemPromptOptions: allowed }, trustedHost);
		assertEqual(allowed.skills?.length, 1, "project skill not added with trust");
		assertEqual(allowed.skills[0].description, "Project skill");
		trusted.shutdown("quit");
	});
});

/** Replacing a skill record updates name, description and flag. */
scenario("when_skill_replaced_then_facts_updated", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: {} }));
		write(
			"agent/skills/x/SKILL.md.template",
			"---\nname: x\ndescription: New description\ndisable-model-invocation: true\n---\nbody",
		);
		const target = join(agentDir, "skills", "x", "SKILL.md");
		const warnings = [];
		const session = makeSession({ agentDir, projectDir });
		await session.start(sessionHost(warnings), "startup");
		const options = {
			skills: [
				{
					name: "old",
					description: "old",
					filePath: target,
					baseDir: dirname(target),
					sourceInfo: {
						path: target,
						source: "local",
						scope: "user",
						origin: "top-level",
						baseDir: dirname(target),
					},
					disableModelInvocation: false,
				},
			],
		};
		await session.beforeAgentStart({ systemPromptOptions: options }, sessionHost(warnings));
		assertEqual(options.skills[0].name, "x", "skill name not updated");
		assertEqual(options.skills[0].description, "New description", "skill description not updated");
		assertEqual(options.skills[0].disableModelInvocation, true, "skill flag not updated");
		session.shutdown("quit");
	});
});

/** `"var"` records: last value per name, `"role"` is not read. */
scenario("when_var_entries_read_then_last_value_per_name", async () => {
	const entries = [
		{ type: "message", role: "user", content: "hello" },
		{
			type: "custom",
			customType: "role",
			data: { name: "role", model: "deepseek/flash", level: "max", text: "Role design" },
		},
		{ type: "custom", customType: "var", data: { name: "role", value: "preflight" } },
		{ type: "custom", customType: "var", data: { name: "vllm", value: "off" } },
		{ type: "custom", customType: "var", data: { name: "role", value: "develop" } },
		// Discriminating foreign records: a valid `{name, value}` pair but not our
		// `customType`/`type` — without the gates they would override expected values.
		{ type: "custom", customType: "role", data: { name: "role", value: "from-role" } },
		{ type: "custom", data: { name: "vllm", value: "from-no-customType" } },
		{ type: "message", customType: "var", data: { name: "branch", value: "from-message" } },
		{ type: "custom", customType: "var", data: { name: 42, value: "x" } },
		{ type: "custom", customType: "var", data: "string" },
		{ type: "custom", customType: "var" },
		null,
	];
	assertEqual(
		readVarOverrides(entries),
		{ role: "develop", vllm: "off" },
		"var records read incorrectly",
	);
});

/** `"var"` record: strict `{name, value}` payload; repeat and refusal write nothing. */
scenario("when_variable_change_written_then_payload_strict", async () => {
	const view = { role: "preflight" };
	const session = {
		currentView: () => ({ ...view }),
		setVariable: async (name, value) => {
			view[name] = value;
			return { ok: true };
		},
	};
	const entries = [];
	const write = (customType, data) => entries.push([customType, data]);
	const result = await changeVariable(session, write, "role", "develop");
	assertEqual(result, { ok: true, written: true }, "variable change not recorded");
	assertEqual(entries, [["var", { name: "role", value: "develop" }]], "var record payload is wrong");
	assertEqual(Object.keys(entries[0][1]), ["name", "value"], "payload has extra fields");
	assertEqual(view.role, "develop", "session did not get the new value");
	const again = await changeVariable(session, write, "role", "develop");
	assertEqual(again, { ok: true, written: false }, "repeated value recorded");
	const refused = {
		currentView: () => ({ branch: "main" }),
		setVariable: async () => ({ ok: false, problem: "computed" }),
	};
	const failed = await changeVariable(refused, write, "branch", "x");
	assertEqual(failed, { ok: false, written: false, problem: "computed" }, "session refusal not propagated");
	assertEqual(entries.length, 1, "a record on repeat or refusal");
});

/** `ctrl+r`: the next value of the status variable is a session override — the context is not applied. */
scenario("when_status_value_cycled_then_session_override_without_apply", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write(
			"agent/template.json",
			JSON.stringify({
				vars: {
					role: { values: ["preflight", "develop"], initial: "preflight" },
					branch: { values: { shell: "false" }, initial: "main" },
				},
				statusVariable: "role",
			}),
		);
		write("agent/AGENTS.md.template", "Role {{role}}");
		const target = join(agentDir, "AGENTS.md");
		const warnings = [];
		const session = makeSession({ agentDir, projectDir, execute: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
		await session.start(sessionHost(warnings), "startup");
		await session.beforeAgentStart({ systemPromptOptions: {} }, sessionHost(warnings));
		assertEqual(readFileSync(target, "utf-8"), "Role preflight", "startup target file");
		assertEqual(session.statusVariable(), "role", "statusVariable not read from the config");
		assertEqual(session.currentValues().branch, undefined, "a failed value list gives no list to cycle");
		assertEqual(
			statusLineText(session.isStale(), session.statusVariable(), session.currentView()),
			"template ✓ role=preflight",
			"status before the cycle",
		);

		const entries = [];
		const writeEntry = (customType, data) => entries.push([customType, data]);
		const first = nextVariableValue(session.currentValues().role, session.currentView().role);
		const changed = await changeVariable(session, writeEntry, "role", first);
		assertEqual(changed, { ok: true, written: true }, "the first cycle did not change the value");
		assertEqual(entries, [["var", { name: "role", value: "develop" }]], "var record of the first cycle");
		assertEqual(readFileSync(target, "utf-8"), "Role preflight", "the cycle applied the context");
		assertEqual(session.isStale(), true, "the cycle did not mark the context stale");
		assertEqual(
			statusLineText(session.isStale(), session.statusVariable(), session.currentView()),
			"template ! role=develop",
			"status after the first cycle",
		);

		const second = nextVariableValue(session.currentValues().role, session.currentView().role);
		assertEqual(second, "preflight", "the value ring did not wrap");
		await changeVariable(session, writeEntry, "role", second);
		assertEqual(entries.length, 2, "the second cycle did not write a record");
		session.shutdown("quit");
	});
});

/** `alt+r`: the next status variable of the ring is written into `template.json`. */
scenario("when_status_variable_cycled_then_field_written_rest_kept", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		const vars = {
			role: { values: ["preflight", "develop"], initial: "preflight" },
			mode: { values: ["plan", "code"], initial: "plan" },
			note: { initial: "draft" },
		};
		const configPath = write("agent/template.json", JSON.stringify({ vars }));
		write("agent/AGENTS.md.template", "Role {{role}}; mode {{mode}}");
		const warnings = [];
		const session = makeSession({ agentDir, projectDir });
		await session.start(sessionHost(warnings), "startup");

		const choices = statusVariableChoices(session.currentValues());
		assertEqual(choices, ["role", "mode"], "the ring excludes a variable without a list");
		assertEqual(nextStatusVariable(choices, session.statusVariable()), "role", "the first choice");

		const first = session.saveStatusVariable(nextStatusVariable(choices, session.statusVariable()));
		assertEqual(first, { ok: true }, "the status variable was not written");
		assertEqual(session.statusVariable(), "role", "the session did not adopt the re-read config");
		assertEqual(
			JSON.parse(readFileSync(configPath, "utf-8")),
			{ vars, statusVariable: "role" },
			"the field was not added or the rest changed",
		);
		assertEqual(
			statusLineText(session.isStale(), session.statusVariable(), session.currentView()),
			"template ✓ role=preflight",
			"status of the first choice",
		);
		assertEqual(loadVarsConfig(agentDir, NO_ENV).statusVariable, "role", "the file does not parse after the write");

		const second = session.saveStatusVariable(nextStatusVariable(choices, session.statusVariable()));
		assertEqual(second, { ok: true }, "the second choice was not written");
		assertEqual(loadVarsConfig(agentDir, NO_ENV).statusVariable, "mode", "the field after the second choice");
		assertEqual(
			statusLineText(session.isStale(), session.statusVariable(), session.currentView()),
			"template ✓ mode=plan",
			"status of the second choice",
		);
		assertEqual(nextStatusVariable(choices, "mode"), "role", "the variable ring does not wrap");
		session.shutdown("quit");
	});
});

/** A failed write leaves the current status variable and the file as is. */
scenario("when_status_variable_write_fails_then_variable_unchanged", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		const configPath = write(
			"agent/template.json",
			JSON.stringify({ vars: { role: { values: ["a"], initial: "a" } }, statusVariable: "role" }),
		);
		write("agent/AGENTS.md.template", "Role {{role}}");
		const warnings = [];
		const session = makeSession({ agentDir, projectDir });
		await session.start(sessionHost(warnings), "startup");

		writeFileSync(configPath, "{broken");
		const broken = session.saveStatusVariable("role");
		assertEqual(broken.ok, false, "a broken config did not fail the write");
		assert(typeof broken.problem === "string" && broken.problem.length > 0, "no reason of the write failure");
		assertEqual(readFileSync(configPath, "utf-8"), "{broken", "the failed write touched the config file");
		assertEqual(session.statusVariable(), "role", "the failed write changed the current variable");

		rmSync(configPath);
		mkdirSync(configPath);
		const unreadable = session.saveStatusVariable("role");
		assertEqual(unreadable.ok, false, "a directory instead of the config did not fail the write");
		assertEqual(session.statusVariable(), "role", "the read failure changed the current variable");
		session.shutdown("quit");
	});
});

/** Menu: every variable is a row with a status; implicit ones read-only. */
scenario("when_menu_built_then_implicit_rows_with_status", async () => {
	// A live session returns only declared variables in `currentValues()`
	// (declaring `model`/`level` is a config error), so the "implicit are not
	// offered" guarantee is their absence from the facts.
	const session = {
		currentView: () => ({ model: "deepseek/flash", level: "max", role: "develop", branch: "main" }),
		appliedView: () => ({ model: "deepseek/flash", level: "max", role: "preflight", branch: "main" }),
		currentValues: () => ({ role: ["preflight", "develop"], branch: undefined }),
		computedAge: (name) => (name === "branch" ? 3200 : undefined),
	};
	const facts = variableFacts(session, { role: "develop" });
	assertEqual(facts.map((fact) => fact.name), ["role", "branch", "model", "level"], "menu row order");
	assertEqual(facts[0].overridden, true, "session override not marked");
	assertEqual(facts[0].changed, true, "unapplied override not marked changed");
	assertEqual(facts[1].computed, true, "computed variable not marked");
	assertEqual(facts[1].changed, false, "value matching the applied context not marked current");
	assertEqual(facts[1].ageMs, 3200, "computed value age not passed through");
	const model = facts.find((fact) => fact.name === "model");
	assertEqual(model?.implicit, true, "model is an implicit row");
	assertEqual(model?.changed, false, "unchanged model not marked changed");
	const items = menuItems(facts);
	assertEqual(
		items.map((item) => [item.action, item.facts?.name ?? null]),
		[
			["change", "role"],
			["recompute", "branch"],
			["implicit", "model"],
			["implicit", "level"],
			["recomputeAll", null],
			["apply", null],
			["rewriteFiles", null],
		],
		"menu composition",
	);
	const rowText = (item) => menuRowSegments(item).map((segment) => (segment.kind === "status" ? variableStatusMark(segment.changed) : segment.text)).join(" · ");
	assertEqual(rowText(items[0]), "role = develop · session override · !", "unapplied variable row");
	assertEqual(rowText(items[1]), "branch = main · computed, 3 s — Enter: recompute · ✓", "applied computed row");
	assertEqual(rowText(items[2]), "model = deepseek/flash · ✓", "implicit model row");
	assertEqual(rowText(items[3]), "level = max · ✓", "implicit level row");
	assertEqual(rowText(items[4]), "recompute all variables", "recompute-all row");
	assertEqual(rowText(items[5]), "update current session context", "apply row");
	assertEqual(rowText(items[6]), "rewrite files on disk", "rewrite-files row");
	assertEqual(
		items.filter((item) => item.action === "apply" || item.action === "rewriteFiles").map((item) => item.action),
		["apply", "rewriteFiles"],
		"apply must come before rewrite files",
	);
});

/** Rewrite files: targets fresh, versions and applied context untouched. */
scenario("when_rewrite_files_then_targets_fresh_versions_untouched", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write("agent/template.json", JSON.stringify({ vars: { who: { initial: "world" } } }));
		write("agent/AGENTS.md.template", "Hello {{who}}");
		write("agent/agents/foo.md.template", "---\nname: foo\ndescription: d\n---\nAgent {{who}}");
		const target = join(agentDir, "AGENTS.md");
		const agentTarget = join(agentDir, "agents", "foo.md");
		const warnings = [];
		const session = makeSession({ agentDir, projectDir });
		assertEqual(session.rewriteFiles(), false, "rewrite before start did not fail");
		await session.start(sessionHost(warnings), "startup");
		// The first turn closes the startup delivery: after that the session runs as usual.
		await session.beforeAgentStart({ systemPromptOptions: {} }, sessionHost(warnings));
		assertEqual(readFileSync(target, "utf-8"), "Hello world", "startup target file");
		assert(readFileSync(agentTarget, "utf-8").includes("Agent world"), "startup agent target file");

		const changed = await session.setVariable("who", "sun");
		assertEqual(changed.ok, true, "variable change failed");
		assertEqual(readFileSync(target, "utf-8"), "Hello world", "variable change rewrote the target file");
		assertEqual(session.isStale(), true, "variable change did not mark the context stale");

		// Rewrite files: the target gets the current version, the applied one does not change.
		assertEqual(session.rewriteFiles(), true, "rewrite files failed");
		assertEqual(readFileSync(target, "utf-8"), "Hello sun", "target file not re-rendered");
		assert(readFileSync(agentTarget, "utf-8").includes("Agent sun"), "agent target file not re-rendered");
		assertEqual(session.isStale(), true, "rewrite aligned the versions");

		// The session keeps working on the applied version.
		const options = { contextFiles: [{ path: target, content: "Hello sun" }] };
		await session.beforeAgentStart({ systemPromptOptions: options }, sessionHost(warnings));
		assertEqual(options.contextFiles[0].content, "Hello world", "rewrite replaced the applied context");
		assertEqual(readFileSync(target, "utf-8"), "Hello sun", "session turn rolled back the re-rendered target file");

		// The apply button aligns versions; a repeated rewrite is safe.
		assertEqual(session.apply(), true, "apply failed");
		assertEqual(session.isStale(), false, "apply did not align versions");
		assertEqual(session.rewriteFiles(), true, "repeated rewrite failed");
		assertEqual(readFileSync(target, "utf-8"), "Hello sun", "repeated rewrite corrupted the target file");
		session.shutdown("quit");
	});
});

/** Value age: seconds, minutes, hours, days. */
scenario("when_age_formatted_then_compact", async () => {
	assertEqual(
		[
			formatAge(0),
			formatAge(999),
			formatAge(1000),
			formatAge(59_000),
			formatAge(60_000),
			formatAge(3_599_000),
			formatAge(3_600_000),
			formatAge(90_000_000),
		],
		["0 s", "0 s", "1 s", "59 s", "1 min", "59 min", "1 h", "1 d"],
		"age formatted incorrectly",
	);
});

/** Status line: a state glyph and the status variable pair. */
scenario("when_status_text_then_glyph_and_status_variable", async () => {
	assertEqual(statusLineText(false, undefined, {}), "template ✓", "status without a variable");
	assertEqual(statusLineText(true, undefined, {}), "template !", "stale status without a variable");
	assertEqual(statusLineText(true, "role", { role: "develop" }), "template ! role=develop", "status with the variable");
	assertEqual(statusLineText(false, "role", { role: "" }), "template ✓ role=—", "empty value");
	assertEqual(
		statusLineText(false, "long", { long: "0123456789abcdefghij" }),
		"template ✓ long=0123456789abcde…",
		"long value not truncated",
	);
	assertEqual(statusLineText(undefined, undefined, {}), "template ‼", "status without a view");
});

/** Status variable ring: declared variables with a non-empty value list. */
scenario("when_status_variable_choices_then_ring_over_value_lists", async () => {
	const values = { role: ["preflight", "develop"], note: undefined, empty: [], branch: ["main"] };
	assertEqual(statusVariableChoices(values), ["role", "branch"], "choices not filtered by the value list");
	assertEqual(statusVariableChoices({}), [], "choices of an empty view");
	assertEqual(nextStatusVariable(["role", "branch"], undefined), "role", "first choice without a current one");
	assertEqual(nextStatusVariable(["role", "branch"], "role"), "branch", "next choice after the current one");
	assertEqual(nextStatusVariable(["role", "branch"], "branch"), "role", "choice ring does not wrap");
	assertEqual(nextStatusVariable(["role"], "gone"), "role", "first choice when the current one is not in the ring");
	assertEqual(nextStatusVariable([], "role"), undefined, "a choice ring out of nothing");
});

/** Value ring of the status variable. */
scenario("when_status_variable_value_cycled_then_ring", async () => {
	assertEqual(nextVariableValue(["preflight", "develop"], "preflight"), "develop", "next value");
	assertEqual(nextVariableValue(["preflight", "develop"], "develop"), "preflight", "value ring does not wrap");
	assertEqual(nextVariableValue(["preflight", "develop"], "gone"), "preflight", "first value outside the list");
	assertEqual(nextVariableValue(["only"], "only"), "only", "single-value ring");
	assertEqual(nextVariableValue([], "gone"), undefined, "value ring of an empty list");
});

/** Menu facts from a live session: a computed one with age, an override. */
scenario("when_menu_facts_from_session_then_age_and_override", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write(
			"agent/template.json",
			JSON.stringify({ vars: { who: { initial: "world" }, branch: { initial: { shell: "branch" } } } }),
		);
		write("agent/AGENTS.md.template", "Hello {{who}} {{branch}}");
		const execute = async () => ({ code: 0, stdout: "main\n", stderr: "" });
		let clock = 1000;
		const session = new TemplateSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			homeDir: EMPTY_HOME,
			execute,
			now: () => clock,
		});
		await session.start(sessionHost([]), "startup");
		clock = 4500;
		const facts = variableFacts(session, { who: "sun" });
		assertEqual(
			facts.map((fact) => [fact.name, fact.computed, fact.overridden]),
			[
				["who", false, true],
				["branch", true, false],
				["model", false, false],
				["level", false, false],
			],
			"session facts for the menu",
		);
		assertEqual(facts[1].ageMs, 3500, "computed variable age in the menu");

		assertEqual(
			menuItems(facts).map((item) => item.action),
			["change", "recompute", "implicit", "implicit", "recomputeAll", "apply", "rewriteFiles"],
			"menu actions from the session facts",
		);
		session.shutdown("quit");
	});
});

/** A derived variable row: editable as usual, no age and no recompute. */
scenario("when_derived_variable_facts_then_overridable_row", async () => {
	await withTempTree(async ({ agentDir, projectDir, write }) => {
		write(
			"agent/template.json",
			JSON.stringify({
				vars: {
					is_flash: { compute: 'in model "deepseek/flash"' },
					branch: { initial: { shell: "branch" } },
				},
			}),
		);
		write("agent/AGENTS.md.template", "flash {{is_flash}}");
		const session = new TemplateSession({
			agentDir,
			projectDir,
			parseHeader: simpleHeaderParser,
			env: {},
			homeDir: EMPTY_HOME,
			execute: async () => ({ code: 0, stdout: "main\n", stderr: "" }),
			now: () => 1000,
		});
		await session.start(sessionHost([]), "startup");
		const derived = variableFacts(session, { is_flash: "false" }).find((fact) => fact.name === "is_flash");
		assertEqual(
			[derived.computed, derived.ageMs, derived.overridden, derived.values],
			[false, undefined, true, ["true", "false"]],
			"derived variable facts",
		);
		const actions = menuItems(variableFacts(session, { is_flash: "false" }))
			.filter((item) => item.facts?.name === "is_flash")
			.map((item) => item.action);
		assertEqual(actions, ["change"], "menu actions of a derived variable");
		session.shutdown("quit");
	});
});

if (scenarios.length === 0) {
	console.error("no scenarios");
	process.exitCode = 1;
} else {
	let failures = 0;
	for (const { name, run } of scenarios) {
		try {
			await run();
			console.log(`ok — ${name}`);
		} catch (error) {
			failures += 1;
			console.error(`FAIL — ${name}`);
			console.error(error);
		}
	}
	if (failures > 0) {
		console.error(`\n${failures} FAIL`);
		process.exitCode = 1;
	} else {
		console.log("ALL OK");
	}
}
