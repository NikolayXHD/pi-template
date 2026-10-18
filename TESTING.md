# pi-template check scenarios

Mechanism: sources `X.template` are rendered into targets `X` under the
session view; `pi` reads the targets natively, the extension keeps them
fresh and delivers the context by section replacement. Checks fall into a
scenario run of the engine (`node probe.mjs`), live runs against the pi SDK
(`live/*.mjs`) and manual scenarios in a session; the manual ones cover what
needs prompt delivery, the menu and cross-process reads.

## Automated check

`node probe.mjs` — 94 scenarios without a framework and without a pi
process: it prints `ok — name`, on failure `FAIL — name`, and `ALL OK` at
the end. Coverage:

- **engine**: `template.json` parsing, the shell value contract and command
  environment, `@` values, strict canonical serialization; grammar and lint
  (legal and rejected forms, the `@` qualifier, partials with resolution on
  disk, literals and levels), render (include texts are read and linted when
  included), the two-stage agent file render;
- **consumption points**: the target file lock (re-entry, foreign and stale
  ownership), the source list and include resolution, `mtime+size` versions
  (including the files of the last render's includes), set render with file
  failures, subagent identity, session lifecycle
  (start apply, delivery by replacement and addition, `/reload`, read and
  spawn brackets, recompute);
- **UX**: `"var"` records (strict payload, `"role"` ignored), menu
  composition, computed ages, the status line, the `statusVariable` field
  and the quick-switch rings (`ctrl+r`/`alt+r`).

## Live runs

Requirements: `npm install` in the package (handlebars) and `pi` installed
globally under the same `node` (the SDK is looked up from
`process.execPath` in `live/sdk.mjs`; if pi is not found the script says
so). Run from the package root; temporary directories are created by the
scripts themselves:

```bash
node live/smoke.mjs          # extension load, the first target render
node live/prompt.mjs         # turn sections with the rendered context
node live/delivery.mjs       # delivery with foreign targets (section replacement)
node live/first-run.mjs      # no targets — sections are added
node live/derived.mjs        # the child's derived prompt is not rewritten
node live/registration.mjs   # registerRequiredChildExtensions (pi-subagents stub)
node live/ux.mjs             # the /template command, menu, status, var, resume
node live/typecheck.mjs      # tsc over all modules (config generated in temp)
```

Expectations:

- `smoke` — `extension errors: []`, the `AGENTS.md`, `SKILL.md`,
  `SYSTEM.md` targets exist and carry rendered text, `SMOKE OK`;
- `prompt` — the same targets, then `system sections: …`, `SMOKE OK`;
- `delivery` — `project_context fresh: true`, `skills fresh: true`,
  `preamble`/`addendum` are our texts (previous foreign ones rewritten),
  `DELIVERY SMOKE OK`;
- `first-run` — `customPrompt at load: undefined`, `contextFiles at load:
  0 skills at load: 0`, then the same fresh texts, `DELIVERY SMOKE OK`;
- `derived` — `preamble`/`addendum` carry the derived strings,
  `DERIVED TEXT SMOKE OK`;
- `registration` — the marker has `id: "pi-template"` and the `index.ts`
  path, `REGISTRATION SMOKE OK`;
- `ux` — 91 `ok:` checks, `LIVE UX OK` at the end (a failure gives
  `LIVE UX FAIL` and exit code 1);
- `typecheck` — `TYPECHECK OK` (`tsc` must be in `PATH`).

The scripts do not replace the manual scenarios: the real TUI, RPC dialogs,
prompt delivery in a real session and cross-process reads are checked by
hand below.

## What to look at and where

- **Status line**: one state glyph (`template ✓` / `template !` /
  `template ‼` with a broken config) and, when `statusVariable` is set, the
  pair of that variable (`template ! role=develop`).
- **Menu rows**: a variable row shows the variable status as a colored
  glyph — `✓` (the value is in the applied context) or `!` (it differs: an
  override, a recompute or a source edit happened without applying).
- **Session file** (`PI_SESSION_FILE`): a variable change gives a
  `customType: "var"` record with `data` of the form `{name, value}`; there
  are no new-format role records (`"role"` is the old format and is
  ignored).
- **Targets**: `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`,
  `skills/*/SKILL.md`, `prompts/*.md`, `agents/*.md` next to their sources;
  they must not contain raw `{{…}}` tags.
- **Warnings** arrive as UI notifications; their text is part of the
  expected observation.

## Manual scenarios

Preconditions: the package is installed
(`git:github.com/NikolayXHD/pi-template`), `template.json` has a static
variable (for example `role` with a value list), optionally a shell- and an
env-computed one.

1. **Session start.** Run `pi` in a project. Expectation: on the first turn
   the system prompt has the global/project context, skill descriptions,
   SYSTEM/APPEND (added when targets are missing); targets appeared next to
   the sources; no raw tags. The role comes from `initial` (in the live
   `~/.pi/agent`: `preflight`).
2. **`/reload`.** Edit `AGENTS.md.template` without applying: the next turn
   sees the previous text and the status shows `!`. Run
   `/reload`. Expectation: the target was rewritten before pi re-read it,
   the text is new, versions match.
3. **Variable change.** `/template` → a static variable row → choose or
   enter a value. Expectation: the context is unchanged, the status is
   "stale" (`!`); when the changed variable is the `statusVariable`, the
   line shows its new pair (`template ! role=develop`); the session file has
   a `"var"` record; no other records.
4. **Apply button.** "update current session context". Expectation: targets
   rewritten, the next turn sees the new text (including the role text for
   the new `role` value), the status is "up to date".
5. **Recompute one.** Enter on a computed variable. Expectation: the command
   is re-run, the value and age are updated; if the text changed the status
   is "stale" and applying is not automatic. A computed variable is not
   offered for change.
6. **Recompute all.** "recompute all variables": the age of every shell/env
   value is reset.
7. **Resume.** Change a variable, quit, come back with a resumed session.
   Expectation: the view and the target carry the last value from the
   `"var"` records; an old-format `role` record changes nothing.
8. **New session.** Start anew without resume: machine values, status
   without overrides.
9. **Broken config.** Corrupt `template.json`. Expectation: `/template`
   answers with the warning "context not built"; the status is `‼`; no
   crash, previous targets are in place.
10. **Read a skill body.** Let the model read `SKILL.md` while another pi
    window holds its own target. Expectation: under the lock the target is
    brought to this session's applied version, the lock is released on
    `tool_execution_end`.
11. **Subagent spawn.** Call `subagent` with agent `foo` (with `model` when
    needed). Expectation: `agents/foo.md` is rendered under the spawn
    parameters (`model@`/`level@` from the header/parameters), pi-subagents
    reads the fresh target; the child receives the extension (the
    `<active_agent>` tag, `@` values).
12. **Advertised catalog.** At the parent session start the advertised
    agent catalog carries fresh `agents/*.md` headers; a target update
    between two starts reaches the catalog only at the next update.
13. **Rewrite files on disk.** Change a variable in `/template` (the status
    becomes "stale"), then choose "rewrite files on disk". Expectation:
    targets carry the current values, the status stays "stale", the session
    keeps answering on the previous applied context, no session record is
    added, the notification says `targets rewritten`.
14. **Quick switch.** With a status variable declared (for example `role`
    with a value list of two or more): `ctrl+r` cycles its value — the
    status line shows `template ! role=<new value>`, a `"var"` record
    appears, the prompt is not updated (apply stays explicit). `alt+r`
    cycles the status variable among declared ones with a value list; the
    `statusVariable` field in `template.json` is written immediately and
    the status line redraws. On a variable whose value list failed to
    compute `ctrl+r` does nothing. pi reports the `ctrl+r` conflict with
    "rename session" at startup.

## Known states and limitations

- The `/template` menu is checked in live runs with a UI stub component:
  TUI colors and RPC dialog cancellation are left to the manual scenarios.
- Real session prompt sections are observed by the live scripts through an
  in-memory SDK session; the real terminal is covered by manual scenarios
  1–9.
- Outside the pi process (`machine`/pane-native runs, external CLIs) the
  extension does not work: the targets remain coherent last successful
  text.
- The `ctrl+r`/`alt+r` shortcuts are dispatched by the interactive pi mode
  only: the RPC/print modes have no key dispatch, and a call outside the
  interactive mode changes nothing.
- Parallel sessions switch the shared targets between their views; a
  foreign read under the lock gets the variant of the session that read it.
