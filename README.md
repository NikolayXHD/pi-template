# pi-template

A pi extension for context templating. Any text part of the system prompt —
the global and project `AGENTS.md` (including the `cwd` ancestor chain),
`SYSTEM.md`/`APPEND_SYSTEM.md`, skill descriptions and bodies, prompts, agent
files — can branch on variables whose values come from the config, the
environment, or a shell command.

## How it works

- A **source** is an `X.template` file, the only file edited by hand. A
  **target** is the rendered copy `X` next to the source. pi finds targets
  natively (`AGENTS.md`, `SKILL.md`, `*.md` prompts, `SYSTEM.md`,
  `APPEND_SYSTEM.md`); none of its mechanisms sees `.template` files.
- At start a session computes the **view** — the full set of variable
  values — and renders the targets. The current context version is kept in
  memory and delivered into the prompt by pointwise section replacement;
  the targets are the last-success cache.
- Foreign reads of targets (the read tool for skill bodies, pi-subagents for
  agent files) run under a file lock: the extension re-renders the target
  under its session's view, the reader reads, the lock is released.
- A file render failure does not rewrite the target and does not let raw
  tags into the prompt: the consumer gets the previous successful text, and
  the reason goes to the UI as a warning.

## Example usage: implement plan mode in Pi

A **mode** is how the agent works in a session — planning, developing,
reviewing — and the mode text is templated: a variable picks which text
enters `AGENTS.md` (rules, tone, delegation policy). A mode is not an
engine concept: it is an ordinary variable plus a dynamic partial.

The reference setup — modes live in `modes/`, one source per mode; the
agent directory:

```text
~/.pi/agent/
├── template.json
├── AGENTS.md.template
└── modes/
    ├── plan.md.template
    └── code.md.template
```

`template.json` — the variable whose values are the mode files:

```json
{
  "vars": {
    "mode": {
      "values": { "shell": "basename -s .md.template modes/*.md.template" },
      "initial": "plan"
    }
  },
  "statusVariable": "mode"
}
```

`AGENTS.md.template` — the selected mode is included as a dynamic partial:

```md
{{> (concat "modes/" mode ".md")}}
```

The partial name is the plain name (`modes/plan.md`), resolved on disk
at render time; the text is read from the source `modes/plan.md.template` —
mode files have no target and are never written to. Adding a mode is
dropping a file into `modes/`.

## Installation

The package installs as a pi git package: in the agent directory
`settings.json`

```json
{ "packages": ["git:github.com/NikolayXHD/pi-template"] }
```

The entry point is declared in `package.json` (`pi.extensions`). The
dependency is `handlebars` (`make deps` or `npm install`).

## `template.json` config

It lives in the agent directory (`~/.pi/agent/template.json`) and declares
variables:

```json
{
  "vars": {
    "vllm": {
      "values": ["on", "off"],
      "initial": "on"
    },
    "git_branch": {
      "initial": { "shell": "git rev-parse --abbrev-ref HEAD" },
      "cwd": "project"
    }
  },
  "statusVariable": "vllm"
}
```

The top-level **`statusVariable`** names the variable the status line shows
(`template ✓ vllm=on`); it must name a declared variable with a non-empty
value list — otherwise the config is an error. Without the field the status
line is just the state glyph.

Variable fields:

- **`values`** — a static list of strings or `{"shell": "…"}`: the values
  are stdout lines, one per line (trim, empty lines ignored, duplicates
  collapsed). A non-zero exit or a timeout (5 s) gives a warning and leaves
  the variable without a list. The list feeds lint: condition literals are
  checked against it, dynamic partial names are resolved on disk.
- **`initial`** — the machine value: a string, `{"shell": "…"}` or
  `{"env": "VAR"}` (a lookup with no command run). A computed `initial`
  makes the variable read-only — a session override is forbidden for it.
- **`@`** and **`@<agent name>`** — the variable value at a subagent;
  `@<name>` wins over `@`. They replace both the machine and the computed
  value; without either key a subagent sees the machine value (a computed
  one sees its computation). Strings only.
- **`cwd`** — the command working directory: `"agent"` (default, the agent
  directory) or `"project"` (the session cwd; children use their own).

Config rules:

- variable names are identifiers; the name is the env variable name, and a
  collision with the process environment is an error;
- `model` and `level` are implicit and read-only; declaring them is an
  error;
- an unknown key is an error; a broken `template.json` means the view is not
  built and there is no re-render, with a warning naming the reason;
- commands run in the platform system shell; string substitution of values
  into the command text is forbidden: the command receives variable values
  through the environment;
- computation follows declaration order; a variable is never computed
  twice.

Value priority: a session override wins over `initial`; computed variables
have no override.

## Template syntax

The vocabulary is deliberately narrow; everything outside it is a lint
error, not a silent rejection:

- `{{#if (eq mode "plan")}}…{{else}}…{{/if}}`,
  `{{#if (in vllm "on" "auto")}}…{{/if}}`, and the same with `{{#unless}}`;
- interpolation `{{mode}}` — declared variables and the implicit
  `{{model}}`/`{{level}}`;
- **partials**: `{{> roles/snippets/tests.md}}` — the name is a path from
  the root of its directory (agent ones from the agent directory, project
  ones from the project root with the `.pi/` prefix). The name is resolved
  on disk at render time: the text comes from `X.template` when
  present, otherwise from `X`. There is no pre-scan of directories, so an
  include from an arbitrary directory (`{{> modes/plan.md}}`) resolves like
  any other; a name that escapes its root is not resolved. A missing static
  name is a lint error; a missing value of a dynamic partial is a warning,
  and a selected value without a file fails the render naming the value. The
  include text is linted when it is read (an `@` qualifier is legal only in
  agent files). Names with a leading dot are written as string literals:
  `{{> ".pi/skills/x/SKILL.md"}}`; a dynamic partial is
  `{{> (concat "modes/" mode ".md")}}`, `concat` of literal segments and
  variables, the name is checked for every value in the list;
- comments `{{! … }}`; a literal `{{` in text is escaped as `\{{`;
- frontmatter is rendered alongside the body; a rendered file with
  frontmatter is validated by YAML parsing — skill descriptions and agent
  headers live there.

**The `@` qualifier** references a variable value at a subagent:
`{{[vllm@]}}` (any subagent) and `{{[vllm@foo]}}` (agent `foo`). It is
legal only in agent files (`agents/**`); in the file of agent `foo` only
`@` and `@foo` are allowed.

**Two-stage agent file render.** The child's model and level are determined
by the header of the same file, so the header is rendered iterated to a
fixpoint (preliminary `model`/`level` → YAML of the header → actual values),
and the body with the full future child view: `model@`/`level@` get actual
values, custom `@` variables get the subagent values from the config. A
model or level expression that does not converge is a render error ("header
model depends on `model@`").

## The `/template` command

The extension's only command opens the context management menu:

- session context status as one glyph: `✓` applied, `!` a re-render is
  waiting, `‼` no view built (a broken config);
- implicit `model`/`level` as a read-only row;
- rows of declared variables: the value; for computed ones the value age and
  recompute on Enter; for overridden ones "session override"; the variable
  status as the last segment — a colored glyph: `✓` green (the value is in
  the applied context) or `!` yellow (it differs — the context has not
  been applied since);
- "recompute all variables";
- "update current session context" — applying the current version;
- "rewrite files on disk" — writing the current version into the targets
  without applying it.

A variable change is recorded in the
session (`customType: "var"`, payload `{name, value}`) and does not update
the context by itself — only the status changes. Resume picks up the last
value of each variable from the records.

The quick switch cycles values without the menu: `ctrl+r` takes the next
value of the status variable, `alt+r` takes the next variable of the ring —
declared ones with a non-empty value list. A value change is a session
override, exactly as a menu change: the context is not applied; `alt+r`
writes its choice into `template.json` immediately. In pi `ctrl+r` is the
built-in "rename session" shortcut; the extension overrides it — pi reports
the conflict on startup.

**The status line** shows one state glyph (`✓` applied, `!` a re-render is
waiting, `‼` no view) and, when `statusVariable` is set, its pair:
`template ✓ vllm=on` (a long value is compacted). The fact of a session
override stays in the menu (`session override`).

## Session context versions

The extension keeps two versions of the context files in memory: the
**applied** one (in the prompt and in the targets) and the **current** one
(re-rendered from fresh sources and values).

- Editing a source or an included file, changing a session variable or the
  model/level re-renders only the current version and marks the context
  stale: the prompt itself never changes.
- Applying is explicit only: session start, `/reload`, the "update current
  session context" button. Start and the button deliver the text by
  pointwise section replacement; `/reload` re-reads the targets by pi itself
  (the extension writes the current version on `session_shutdown`). "Rewrite
  files on disk" writes the targets without applying anything.
- Sources and the files of the last render's includes are compared by
  `mtime`+`size` on every turn; computed variables are recomputed only by
  explicit menu actions.

## Subagents

The mechanism requires templates to expand fully in child sessions too: the
extension registers itself as required for them
(`registerRequiredChildExtensions`). A child's variable values are set by
`@`/`@<name>` keys; a child session does not inherit the parent's session
overrides. Outside the pi process (machine/pane-native runs, external CLI
agents) the extension does not work — the targets remain coherent last
successful text.

Package resources (skills and prompts of git/npm packages) are not
templated.

## Checks

`node probe.mjs` — a scenario run of the engine and consumption points.
Live runs against the pi SDK — `live/*.mjs`; scenario descriptions and
manual checks — `TESTING.md`.
