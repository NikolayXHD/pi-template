/**
 * Live zone C check on pi SDK 1.2.0: the `/template` command, the menu,
 * status, `"var"` records, apply, resume, `"role"` ignored and the
 * `ctrl+r`/`alt+r` quick switch.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT, PI } from "./sdk.mjs";

const pi = await import(PI);

let failures = 0;
function check(condition, message) {
	if (!condition) {
		failures += 1;
		console.error(`FAIL: ${message}`);
		return;
	}
	console.log(`ok: ${message}`);
}

async function waitFor(condition, message) {
	for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!condition()) throw new Error(message);
}

function makeUi(mode) {
	const state = { statuses: [], notifications: [], selects: [], inputs: [], script: [], component: undefined, customs: [] };
	const ui = {
		select: async (title, options) => {
			state.selects.push({ title, options });
			const next = state.script.shift();
			if (typeof next !== "string") return undefined;
			if (options.includes(next)) return next;
			const matched = options.find((option) => option.startsWith(`${next} ·`));
			return matched;
		},
		confirm: async () => false,
		input: async (title, placeholder) => {
			state.inputs.push({ title, placeholder });
			const next = state.script.shift();
			return typeof next === "string" ? next : undefined;
		},
		notify: (message, type) => state.notifications.push({ message, type }),
		onTerminalInput: () => () => {},
		setStatus: (key, text) => state.statuses.push([key, text]),
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async (factory) => {
			return await new Promise((resolve) => {
				const tui = { requestRender: () => {} };
				const theme = { fg: (_color, text) => text, bold: (text) => text };
				Promise.resolve(factory(tui, theme, {}, resolve)).then((component) => {
					state.component = component;
					state.customs.push(component);
				});
			});
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: { fg: (_color, text) => text },
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "no UI" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	return { ui, state };
}

async function makeEnvironment(root, entries) {
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(join(agentDir, "skills"), { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(agentDir, "template.json"),
		JSON.stringify({
			vars: {
				role: { values: ["preflight", "develop"], initial: "preflight" },
				branch: { initial: { shell: "printf 'main\\n'" } },
				home: { initial: { env: "HOME" } },
			},
			statusVariable: "role",
		}),
	);
	writeFileSync(join(projectDir, "AGENTS.md.template"), "Role {{role}}; branch {{branch}}");
	const settingsManager = pi.SettingsManager.create(projectDir, agentDir);
	const modelRuntime = await pi.ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider("fake", {
		name: "Fake",
		baseUrl: "http://127.0.0.1:1",
		api: "openai-completions",
		apiKey: "fake",
		models: [
			{
				id: "fake",
				name: "Fake",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		],
	});
	const model = modelRuntime.getModel("fake", "fake");
	if (!model) throw new Error("test model not created");
	const loader = new pi.DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [EXT],
		noExtensions: true,
		noThemes: true,
	});
	await loader.reload();
	const sessionManager = pi.SessionManager.inMemory(projectDir);
	for (const [customType, data] of entries ?? []) sessionManager.appendCustomEntry(customType, data);
	return { agentDir, projectDir, sessionManager, modelRuntime, model, loader, settingsManager };
}

// ——— Main session: menu, variable change, status, apply ———
const root = mkdtempSync(join(tmpdir(), "pi-template-ux-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const env = await makeEnvironment(root);
const { ui, state } = makeUi("rpc");
const created = await pi.createAgentSession({
	cwd: env.projectDir,
	agentDir: env.agentDir,
	modelRuntime: env.modelRuntime,
	model: env.model,
	thinkingLevel: "low",
	resourceLoader: env.loader,
	sessionManager: env.sessionManager,
	settingsManager: env.settingsManager,
});
await created.session.bindExtensions({ uiContext: ui, mode: "rpc" });
check((created.extensionsResult.errors ?? []).length === 0, `extension loaded without errors: ${JSON.stringify(created.extensionsResult.errors)}`);

const runner = created.session.extensionRunner;
const command = runner.getCommand("template");
check(command !== undefined, "/template command registered");

const target = join(env.projectDir, "AGENTS.md");
const initialTarget = readFileSync(target, "utf-8");
check(initialTarget === "Role preflight; branch main", `startup target file: ${JSON.stringify(initialTarget)}`);
const statuses = state.statuses.filter(([key]) => key === "template").map(([, text]) => text);
check(statuses.includes("template ✓ role=preflight"), `status after start: ${JSON.stringify(statuses)}`);

// RPC menu: first change role, then the value develop.
state.script.push("role = preflight", "develop");
await command.handler("", runner.createCommandContext());
const firstSelect = state.selects[0];
check(firstSelect.title.includes("pi-template · ✓"), `menu title with status: ${firstSelect.title}`);
check(
	firstSelect.title.includes("model = fake/fake") && firstSelect.title.includes("(implicit, read-only)"),
	`RPC menu: implicit read-only in the title: ${JSON.stringify(firstSelect.title)}`,
);
check(firstSelect.options.some((option) => option.startsWith("role = preflight")), "the menu has the role change row");
check(firstSelect.options.some((option) => option.includes("branch = main") && option.includes("computed,")), `menu shows the computed age: ${JSON.stringify(firstSelect.options)}`);
check(firstSelect.options.some((option) => option.includes("home = ") && option.includes("computed,")), `env variable with age: ${JSON.stringify(firstSelect.options)}`);
check(firstSelect.options.includes("recompute all variables"), "the menu has recompute all");
check(firstSelect.options.includes("update current session context"), "the menu has the apply button");
const varEntries = env.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "var");
check(varEntries.length === 1 && varEntries[0].data.name === "role" && varEntries[0].data.value === "develop", `var record: ${JSON.stringify(varEntries.map((entry) => entry.data))}`);
check(readFileSync(target, "utf-8") === "Role preflight; branch main", "variable change did not apply the context");
const staleStatus = state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
check(staleStatus === "template ! role=develop", `status after the change: ${staleStatus}`);
check(state.notifications.at(-1)?.message === "pi-template: role = develop — !", `message after the change: ${state.notifications.at(-1)?.message}`);

// Apply button.
state.script.push("update current session context");
await command.handler("", runner.createCommandContext());
check(readFileSync(target, "utf-8") === "Role develop; branch main", "apply button did not update the target file");
const appliedStatus = state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
check(appliedStatus === "template ✓ role=develop", `status after apply: ${appliedStatus}`);

// Recompute the computed variable.
state.script.push(state.selects.at(-1).options.find((option) => option.startsWith("branch = main")));
await command.handler("", runner.createCommandContext());
check(state.notifications.at(-1)?.message.includes("branch = main"), `recompute message: ${state.notifications.at(-1)?.message}`);

// TUI menu: render and navigation.
runner.setUIContext(ui, "tui");
const tuiRun = command.handler("", runner.createCommandContext());
for (let attempt = 0; attempt < 100 && state.component === undefined; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 10));
}
check(state.component !== undefined, "TUI menu opened");
const lines = state.component.render(90);
const text = lines.join("\n");
check(text.includes("template — session context"), "TUI menu: title");
check(text.includes("✓"), "TUI menu: status");
check(text.includes("model = fake/fake") && text.includes("level = off (implicit, read-only)"), "TUI menu: implicit read-only");
check(text.includes("role = develop") && text.includes("session override"), "TUI menu: override");
check(/branch = main · (current|changed) · computed, \d+ s/.test(text), "TUI menu: value age");
check(text.includes("update current session context"), "TUI menu: apply button");
check(text.includes("rewrite files on disk"), "TUI menu: rewrite files item");
state.component.handleInput("\x1b[B");
state.component.handleInput("\x1b[A");
state.component.handleInput("\x1b");
await tuiRun;
check(state.notifications.at(-1)?.message.includes("branch = main"), "TUI menu: Esc closed without actions");

// Source edit: before_agent_start marks "stale", applied by the button.
runner.setUIContext(ui, "rpc");
await new Promise((resolve) => setTimeout(resolve, 10));
writeFileSync(join(env.projectDir, "AGENTS.md.template"), "Role {{role}}; edit {{branch}}");
const sections = {};
await runner.emit({
	type: "before_agent_start",
	messageType: "user",
	prompt: "hello",
	systemPrompt: "",
	systemPromptOptions: sections,
});
check(readFileSync(target, "utf-8") === "Role develop; branch main", "source edit was applied automatically");
check(
	(sections.contextFiles ?? []).some((file) => file.path === target && file.content === "Role develop; branch main"),
	`applied version delivered: ${JSON.stringify(sections.contextFiles)}`,
);
const editedStatus = state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
check(editedStatus === "template ! role=develop", `status after the source edit: ${editedStatus}`);
state.script.push("update current session context");
await command.handler("", runner.createCommandContext());
check(readFileSync(target, "utf-8") === "Role develop; edit main", "button applied the source edit");
const afterEditStatus = state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
check(afterEditStatus === "template ✓ role=develop", `status after applying the edit: ${afterEditStatus}`);

created.session.dispose();
rmSync(root, { recursive: true, force: true });

// ——— Resume: last "var" record value, "role" ignored ———
const resumeRoot = mkdtempSync(join(tmpdir(), "pi-template-resume-"));
process.env.PI_CODING_AGENT_DIR = join(resumeRoot, "agent");
const resumeEnv = await makeEnvironment(resumeRoot, [
	["var", { name: "role", value: "preflight" }],
	["role", { name: "role", model: "deepseek/flash", level: "max", text: "old format" }],
	["var", { name: "role", value: "develop" }],
	// Discriminating foreign record: a valid `{name, value}` pair but not our
	// `customType` — removing the gate would override the value with "from-role".
	["role", { name: "role", value: "from-role" }],
]);
const resumeUi = makeUi("rpc");
const resumed = await pi.createAgentSession({
	cwd: resumeEnv.projectDir,
	agentDir: resumeEnv.agentDir,
	modelRuntime: resumeEnv.modelRuntime,
	model: resumeEnv.model,
	thinkingLevel: "low",
	resourceLoader: resumeEnv.loader,
	sessionManager: resumeEnv.sessionManager,
	settingsManager: resumeEnv.settingsManager,
	sessionStartEvent: { type: "session_start", reason: "resume" },
});
await resumed.session.bindExtensions({ uiContext: resumeUi.ui, mode: "rpc" });
const resumeTarget = readFileSync(join(resumeEnv.projectDir, "AGENTS.md"), "utf-8");
check(resumeTarget === "Role develop; branch main", `resume picked up the last var value: ${JSON.stringify(resumeTarget)}`);
const resumeStatus = resumeUi.state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
check(resumeStatus === "template ✓ role=develop", `resume status: ${resumeStatus}`);
resumed.session.dispose();
rmSync(resumeRoot, { recursive: true, force: true });

// ——— New session: machine values, overrides from scratch ———
const freshRoot = mkdtempSync(join(tmpdir(), "pi-template-new-"));
process.env.PI_CODING_AGENT_DIR = join(freshRoot, "agent");
const freshEnv = await makeEnvironment(freshRoot);
const freshUi = makeUi("rpc");
const fresh = await pi.createAgentSession({
	cwd: freshEnv.projectDir,
	agentDir: freshEnv.agentDir,
	modelRuntime: freshEnv.modelRuntime,
	model: freshEnv.model,
	thinkingLevel: "low",
	resourceLoader: freshEnv.loader,
	sessionManager: freshEnv.sessionManager,
	settingsManager: freshEnv.settingsManager,
});
await fresh.session.bindExtensions({ uiContext: freshUi.ui, mode: "rpc" });
check(readFileSync(join(freshEnv.projectDir, "AGENTS.md"), "utf-8") === "Role preflight; branch main", "new session — machine value");
const freshStatus = freshUi.state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
check(freshStatus === "template ✓ role=preflight", `new session status: ${freshStatus}`);
fresh.session.dispose();
rmSync(freshRoot, { recursive: true, force: true });

// ——— Line input for a variable without a values list ———
const inputRoot = mkdtempSync(join(tmpdir(), "pi-template-input-"));
process.env.PI_CODING_AGENT_DIR = join(inputRoot, "agent");
const inputEnv = await makeEnvironment(inputRoot);
writeFileSync(join(inputEnv.agentDir, "template.json"), JSON.stringify({ vars: { note: { initial: "empty" } } }));
writeFileSync(join(inputEnv.projectDir, "AGENTS.md.template"), "Note: {{note}}");
const inputUi = makeUi("rpc");
const inputSession = await pi.createAgentSession({
	cwd: inputEnv.projectDir,
	agentDir: inputEnv.agentDir,
	modelRuntime: inputEnv.modelRuntime,
	model: inputEnv.model,
	thinkingLevel: "low",
	resourceLoader: inputEnv.loader,
	sessionManager: inputEnv.sessionManager,
	settingsManager: inputEnv.settingsManager,
});
await inputSession.session.bindExtensions({ uiContext: inputUi.ui, mode: "rpc" });
const inputRunner = inputSession.session.extensionRunner;
const inputCommand = inputRunner.getCommand("template");
const inputTarget = join(inputEnv.projectDir, "AGENTS.md");
check(readFileSync(inputTarget, "utf-8") === "Note: empty", `line input: startup target file`);
inputUi.state.script.push("note = empty", "hello");
await inputCommand.handler("", inputRunner.createCommandContext());
check(
	inputUi.state.inputs.length === 1 && inputUi.state.inputs[0].title.includes("note"),
	`line input opened: ${JSON.stringify(inputUi.state.inputs)}`,
);
const inputEntries = inputEnv.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "var");
check(
	inputEntries.length === 1 && inputEntries[0].data.name === "note" && inputEntries[0].data.value === "hello",
	`line input wrote var: ${JSON.stringify(inputEntries.map((entry) => entry.data))}`,
);
check(readFileSync(inputTarget, "utf-8") === "Note: empty", "line input did not apply the context");
const inputStatus = inputUi.state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
check(inputStatus === "template !", `status after line input: ${inputStatus}`);

// Esc in the RPC value dialog also returns to the menu.
const rpcSelectsBefore = inputUi.state.selects.length;
inputUi.state.script.push("note = hello"); // no value — Esc in the input dialog
await inputCommand.handler("", inputRunner.createCommandContext());
check(
	inputUi.state.selects.length === rpcSelectsBefore + 2 &&
		inputEnv.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "var").length === 1,
	`RPC: Esc in the value dialog returned to the menu: ${inputUi.state.selects.length - rpcSelectsBefore} menu choices`,
);

// ——— Session not found: a clear message ———
const realCtx = inputRunner.createCommandContext();
const missingCtx = Object.create(realCtx);
Object.defineProperty(missingCtx, "sessionManager", { value: { getSessionId: () => "no-such-session" } });
await inputCommand.handler("", missingCtx);
check(
	inputUi.state.notifications.at(-1)?.message.includes("no session found"),
	`"session not found" branch: ${JSON.stringify(inputUi.state.notifications.at(-1))}`,
);

// ——— Digest without UI: state and items as text, nothing changes ———
inputRunner.setUIContext(undefined);
const noopUi = inputRunner.getUIContext();
const originalNotify = noopUi.notify;
const digest = [];
noopUi.notify = (message, type) => digest.push({ message, type });
const entriesBeforeDigest = inputEnv.sessionManager.getEntries().length;
await inputCommand.handler("", inputRunner.createCommandContext());
noopUi.notify = originalNotify;
const digestMessage = digest.at(-1)?.message ?? "";
check(digestMessage.includes("pi-template · !"), `digest: status: ${JSON.stringify(digestMessage)}`);
check(
	digestMessage.includes("model = fake/fake") && digestMessage.includes("(implicit, read-only)"),
	"digest: implicit read-only",
);
check(
	digestMessage.includes("note = hello") &&
		digestMessage.includes("recompute all variables") &&
		digestMessage.includes("update current session context") &&
		digestMessage.includes("rewrite files on disk"),
	"digest: menu items",
);
check(digestMessage.includes("UI unavailable"), "digest: mode note");
check(
	inputEnv.sessionManager.getEntries().length === entriesBeforeDigest && readFileSync(inputTarget, "utf-8") === "Note: empty",
	"digest changes nothing",
);
inputSession.session.dispose();
rmSync(inputRoot, { recursive: true, force: true });

// ——— Rewrite files on disk: targets fresh, session untouched ———
const rewriteRoot = mkdtempSync(join(tmpdir(), "pi-template-rewrite-"));
process.env.PI_CODING_AGENT_DIR = join(rewriteRoot, "agent");
const rewriteEnv = await makeEnvironment(rewriteRoot);
mkdirSync(join(rewriteEnv.agentDir, "prompts"), { recursive: true });
writeFileSync(join(rewriteEnv.agentDir, "prompts", "hello.md.template"), "Hello {{role}}");
const rewriteUi = makeUi("rpc");
const rewriteSession = await pi.createAgentSession({
	cwd: rewriteEnv.projectDir,
	agentDir: rewriteEnv.agentDir,
	modelRuntime: rewriteEnv.modelRuntime,
	model: rewriteEnv.model,
	thinkingLevel: "low",
	resourceLoader: rewriteEnv.loader,
	sessionManager: rewriteEnv.sessionManager,
	settingsManager: rewriteEnv.settingsManager,
});
let reloadCalls = 0;
await rewriteSession.session.bindExtensions({
	uiContext: rewriteUi.ui,
	mode: "rpc",
	commandContextActions: {
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		navigateTree: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {
			reloadCalls += 1;
			await rewriteSession.session.reload();
		},
	},
});
// One-time setup: reload so the loader knows the prompt template.
// It is not called after that — the files button re-reads nothing.
await rewriteSession.session.reload();
const rewriteRunner = rewriteSession.session.extensionRunner;
const rewriteCommand = () => rewriteSession.session.extensionRunner.getCommand("template");
const rewriteContext = () => rewriteSession.session.extensionRunner.createCommandContext();
const rewriteStatus = () => rewriteUi.state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
const rewriteVarEntries = () =>
	rewriteEnv.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "var").length;
const promptTarget = join(rewriteEnv.agentDir, "prompts", "hello.md");
const promptTemplate = () => rewriteEnv.loader.getPrompts().prompts.find((prompt) => prompt.name === "hello");
const agentsTarget = join(rewriteEnv.projectDir, "AGENTS.md");
check(readFileSync(promptTarget, "utf-8") === "Hello preflight", `prompt target file at start: ${JSON.stringify(readFileSync(promptTarget, "utf-8"))}`);
check(promptTemplate()?.content === "Hello preflight", `loader knows the prompt template: ${JSON.stringify(promptTemplate()?.content)}`);

// Variable change: targets unchanged, the session context is stale.
rewriteUi.state.script.push("role = preflight", "develop");
await rewriteCommand().handler("", rewriteContext());
const varEntriesBeforeRewrite = rewriteVarEntries();
check(readFileSync(promptTarget, "utf-8") === "Hello preflight", "variable change did not apply the target file");
check(rewriteStatus() === "template ! role=develop", `status before the rewrite: ${rewriteStatus()}`);

// Button: files rewritten; versions, memory and session records untouched.
rewriteUi.state.script.push("rewrite files on disk");
await rewriteCommand().handler("", rewriteContext());
check(readFileSync(promptTarget, "utf-8") === "Hello develop", `prompt target file rewritten: ${JSON.stringify(readFileSync(promptTarget, "utf-8"))}`);
check(readFileSync(agentsTarget, "utf-8") === "Role develop; branch main", `agent target file rewritten: ${JSON.stringify(readFileSync(agentsTarget, "utf-8"))}`);
check(rewriteSession.session.extensionRunner === rewriteRunner, "rewrite restarted the extension runtime");
check(reloadCalls === 0, `rewrite called reload ${reloadCalls} times`);
check(rewriteStatus() === "template ! role=develop", `status after the rewrite: ${rewriteStatus()}`);
check(rewriteVarEntries() === varEntriesBeforeRewrite, "rewrite wrote a session record");
check(promptTemplate()?.content === "Hello preflight", `rewrite does not re-read the loader: ${JSON.stringify(promptTemplate()?.content)}`);
check(rewriteUi.state.notifications.at(-1)?.message === "pi-template: targets rewritten", `rewrite message: ${JSON.stringify(rewriteUi.state.notifications.at(-1))}`);

// The session keeps working on the applied version: delivery returns the previous text.
const rewriteOptions = { contextFiles: [{ path: agentsTarget, content: readFileSync(agentsTarget, "utf-8") }] };
await rewriteRunner.emit({
	type: "before_agent_start",
	messageType: "user",
	prompt: "hello",
	systemPrompt: "",
	systemPromptOptions: rewriteOptions,
});
check(
	rewriteOptions.contextFiles.some((file) => file.path === agentsTarget && file.content === "Role preflight; branch main"),
	`applied context untouched: ${JSON.stringify(rewriteOptions.contextFiles)}`,
);

// The apply button aligns versions; rewritten targets stay fresh.
rewriteUi.state.script.push("update current session context");
await rewriteCommand().handler("", rewriteContext());
check(rewriteStatus() === "template ✓ role=develop", `status after apply: ${rewriteStatus()}`);
check(readFileSync(promptTarget, "utf-8") === "Hello develop", "apply corrupted the rewritten target file");

const rewriteOptionsList = rewriteUi.state.selects.at(-1).options;
check(
	rewriteOptionsList.at(-1) === "rewrite files on disk" &&
		rewriteOptionsList.at(-2) === "update current session context",
	`menu item order: ${JSON.stringify(rewriteOptionsList)}`,
);
rewriteSession.session.dispose();
rmSync(rewriteRoot, { recursive: true, force: true });

// ——— Esc in a value dialog returns to the menu ———
const escRoot = mkdtempSync(join(tmpdir(), "pi-template-esc-"));
process.env.PI_CODING_AGENT_DIR = join(escRoot, "agent");
const escEnv = await makeEnvironment(escRoot);
// A variable without a value list gets a separate input dialog.
writeFileSync(
	join(escEnv.agentDir, "template.json"),
	JSON.stringify({
		vars: {
			role: { values: ["preflight", "develop"], initial: "preflight" },
			note: { initial: "draft" },
			branch: { initial: { shell: "printf 'main\\n'" } },
			home: { initial: { env: "HOME" } },
		},
	}),
);
const escUi = makeUi("tui");
const escSession = await pi.createAgentSession({
	cwd: escEnv.projectDir,
	agentDir: escEnv.agentDir,
	modelRuntime: escEnv.modelRuntime,
	model: escEnv.model,
	thinkingLevel: "low",
	resourceLoader: escEnv.loader,
	sessionManager: escEnv.sessionManager,
	settingsManager: escEnv.settingsManager,
});
await escSession.session.bindExtensions({ uiContext: escUi.ui, mode: "tui" });
const escRunner = escSession.session.extensionRunner;
const escCommand = escRunner.getCommand("template");
const escRun = escCommand.handler("", escRunner.createCommandContext());

// Enter on role → value dialog → Esc (empty script) → back to the menu.
await waitFor(() => escUi.state.customs.length === 1, "root menu did not open");
escUi.state.customs[0].handleInput("\r");
await waitFor(() => escUi.state.customs.length === 2, "Esc in the value dialog did not return to the menu");
check(escUi.state.customs.length === 2, "Esc in the value dialog returned to the menu");
check(escUi.state.selects.length === 1 && escUi.state.selects[0].title === "Variable role", `role value dialog: ${JSON.stringify(escUi.state.selects)}`);
check(escUi.state.customs[1].render(80).join("\n").includes("> role = preflight"), "cursor returned to the role variable");

// Down to note → input dialog → Esc → back to the menu.
escUi.state.customs[1].handleInput("\x1b[B");
escUi.state.customs[1].handleInput("\r");
await waitFor(() => escUi.state.customs.length === 3, "Esc in the input dialog did not return to the menu");
check(escUi.state.customs.length === 3, "Esc in the input dialog returned to the menu");
check(escUi.state.inputs.length === 1 && escUi.state.inputs[0].title === "Value for note", `note input dialog: ${JSON.stringify(escUi.state.inputs)}`);
check(escUi.state.customs[2].render(80).join("\n").includes("> note = draft"), "cursor stayed on the note variable");

// Esc in the root — full close.
escUi.state.customs[2].handleInput("\x1b");
await escRun;
check(escUi.state.customs.length === 3, "no new dialogs after Esc in the root");
check(
	escEnv.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "var").length === 0 &&
		readFileSync(join(escEnv.projectDir, "AGENTS.md"), "utf-8") === "Role preflight; branch main",
	"Esc changed neither variables nor the target file",
);
escSession.session.dispose();
rmSync(escRoot, { recursive: true, force: true });

// ——— Broken template.json: a clear message, no crash ———
const brokenRoot = mkdtempSync(join(tmpdir(), "pi-template-broken-"));
process.env.PI_CODING_AGENT_DIR = join(brokenRoot, "agent");
const brokenEnv = await makeEnvironment(brokenRoot);
writeFileSync(join(brokenEnv.agentDir, "template.json"), JSON.stringify({ vars: { role: "string" } }));
const brokenUi = makeUi("rpc");
const broken = await pi.createAgentSession({
	cwd: brokenEnv.projectDir,
	agentDir: brokenEnv.agentDir,
	modelRuntime: brokenEnv.modelRuntime,
	model: brokenEnv.model,
	thinkingLevel: "low",
	resourceLoader: brokenEnv.loader,
	sessionManager: brokenEnv.sessionManager,
	settingsManager: brokenEnv.settingsManager,
});
await broken.session.bindExtensions({ uiContext: brokenUi.ui, mode: "rpc" });
const brokenStatus = brokenUi.state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
check(brokenStatus === "template ‼", `status with a broken config: ${brokenStatus}`);
await broken.session.extensionRunner.getCommand("template").handler("", broken.session.extensionRunner.createCommandContext());
check(
	brokenUi.state.notifications.some((entry) => entry.type === "warning" && entry.message.includes("context not built")),
	`command with a broken config: ${JSON.stringify(brokenUi.state.notifications)}`,
);
broken.session.dispose();
rmSync(brokenRoot, { recursive: true, force: true });

// ——— Quick switch: ctrl+r cycles the value, alt+r cycles the status variable ———
const switchRoot = mkdtempSync(join(tmpdir(), "pi-template-switch-"));
process.env.PI_CODING_AGENT_DIR = join(switchRoot, "agent");
const switchEnv = await makeEnvironment(switchRoot);
writeFileSync(
	join(switchEnv.agentDir, "template.json"),
	JSON.stringify({
		vars: {
			role: { values: ["preflight", "develop"], initial: "preflight" },
			mode: { values: ["plan", "code"], initial: "plan" },
			note: { initial: "draft" },
		},
		statusVariable: "role",
	}),
);
writeFileSync(join(switchEnv.projectDir, "AGENTS.md.template"), "Role {{role}}; mode {{mode}}; note {{note}}");
const switchUi = makeUi("tui");
const switchSession = await pi.createAgentSession({
	cwd: switchEnv.projectDir,
	agentDir: switchEnv.agentDir,
	modelRuntime: switchEnv.modelRuntime,
	model: switchEnv.model,
	thinkingLevel: "low",
	resourceLoader: switchEnv.loader,
	sessionManager: switchEnv.sessionManager,
	settingsManager: switchEnv.settingsManager,
});
await switchSession.session.bindExtensions({ uiContext: switchUi.ui, mode: "tui" });
const switchRunner = switchSession.session.extensionRunner;
const switchTarget = join(switchEnv.projectDir, "AGENTS.md");
const switchConfigPath = join(switchEnv.agentDir, "template.json");
const switchConfig = () => JSON.parse(readFileSync(switchConfigPath, "utf-8"));
const switchStatus = () => switchUi.state.statuses.filter(([key]) => key === "template").map(([, text]) => text).at(-1);
const switchVarEntries = () =>
	switchEnv.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "var");

check(readFileSync(switchTarget, "utf-8") === "Role preflight; mode plan; note draft", "quick switch: startup target file");
check(switchStatus() === "template ✓ role=preflight", `quick switch: status with the variable: ${switchStatus()}`);

// Interactive mode passes its effective keybindings, where `app.session.rename`
// defaults to ctrl+r: the extension wins and pi reports the conflict.
const shortcuts = switchRunner.getShortcuts({ "app.session.rename": "ctrl+r" });
check(shortcuts.has("ctrl+r") && shortcuts.has("alt+r"), `shortcuts registered: ${[...shortcuts.keys()].join(", ")}`);
check(
	switchRunner.getShortcutDiagnostics().some((entry) => entry.message.includes("ctrl+r")),
	`ctrl+r overrides the built-in rename session: ${JSON.stringify(switchRunner.getShortcutDiagnostics())}`,
);
const ctrlR = shortcuts.get("ctrl+r");
const altR = shortcuts.get("alt+r");

await ctrlR.handler(switchRunner.createContext());
const firstRecord = switchVarEntries().at(-1)?.data;
check(firstRecord?.name === "role" && firstRecord?.value === "develop", `ctrl+r wrote the var record: ${JSON.stringify(firstRecord)}`);
check(readFileSync(switchTarget, "utf-8") === "Role preflight; mode plan; note draft", "ctrl+r applied the context");
check(switchStatus() === "template ! role=develop", `ctrl+r status: ${switchStatus()}`);
check(switchUi.state.notifications.at(-1)?.message === "pi-template: role = develop", `ctrl+r message: ${switchUi.state.notifications.at(-1)?.message}`);

await ctrlR.handler(switchRunner.createContext());
check(switchStatus() === "template ✓ role=preflight", `ctrl+r ring wrap: ${switchStatus()}`);
check(switchVarEntries().length === 2, `ctrl+r ring wrote a second record: ${switchVarEntries().length}`);

await altR.handler(switchRunner.createContext());
check(switchConfig().statusVariable === "mode", `alt+r wrote statusVariable: ${JSON.stringify(switchConfig().statusVariable)}`);
check(
	switchConfig().vars.role.values.length === 2 && switchConfig().vars.note.initial === "draft",
	`alt+r kept the rest of the config: ${JSON.stringify(switchConfig())}`,
);
check(switchStatus() === "template ✓ mode=plan", `alt+r status: ${switchStatus()}`);
check(switchUi.state.notifications.at(-1)?.message === "pi-template: status variable = mode", `alt+r message: ${switchUi.state.notifications.at(-1)?.message}`);
check(
	switchVarEntries().length === 2 && readFileSync(switchTarget, "utf-8") === "Role preflight; mode plan; note draft",
	"alt+r changed the session context",
);

await altR.handler(switchRunner.createContext());
check(switchConfig().statusVariable === "role", `alt+r ring wrap: ${JSON.stringify(switchConfig().statusVariable)}`);

// Shortcuts are dispatched by the interactive mode only: an RPC or headless
// call does nothing.
const entriesBeforeNoUi = switchVarEntries().length;
switchRunner.setUIContext(switchUi.ui, "rpc");
await ctrlR.handler(switchRunner.createContext());
altR.handler(switchRunner.createContext());
switchRunner.setUIContext(undefined);
await ctrlR.handler(switchRunner.createContext());
altR.handler(switchRunner.createContext());
check(
	switchVarEntries().length === entriesBeforeNoUi && switchConfig().statusVariable === "role",
	"shortcuts outside the interactive mode changed nothing",
);
switchSession.session.dispose();
rmSync(switchRoot, { recursive: true, force: true });

console.log(failures === 0 ? "LIVE UX OK" : `LIVE UX FAIL: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
