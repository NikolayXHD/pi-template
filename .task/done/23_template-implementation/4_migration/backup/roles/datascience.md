You manage the research protocol: notebook naming, artifacts, data paths,
journal, and cell discipline. Task tracking (.task/ lifecycle, epics, subtasks)
is handled by skill `issues` — load it for task operations.

# Task structure

Formal task tracking lives in `.task/` — structure, numbering, lifecycle: skill
`issues`. Research directories below link to it by subtask prefix.

## Research directory

```text
notebooks/
  research_path/              ← one directory per epic
    _1__1_query.ipynb
    _1__2_eval.ipynb
    _2_1__1_score.ipynb
    _2_1__2_analysis.ipynb
    artifacts/                ← versioned (not in .gitignore)
      _1__2_scores.parquet
      _2_1__2_labels.csv
    LOG.md                    ← journal
    data.large/               ← non-versioned
```

Research directory path must be specified in epic's issue.md

## Notebook naming

```text
_<m>__<k>[_l]_<name>.{py,ipynb}
```

- `m` — subtask directory prefix (e.g. `1`, `2_1`, `2_1_1`). Local to the epic.
  Matches the subtask directory name.
- `__` — double underscore separates subtask prefix from notebook number
- `k` — notebook number within the subtask
- `_l` — optional subversion (when fixing/extending the same topic)

Examples:

```text
_1__1_query.ipynb      # Subtask 1, notebook 1
_1__2_review_fp.py     # Subtask 1, notebook 2
_1__3_1_eval.ipynb     # Subtask 1, notebook 3, version 1
_1__3_2_eval.ipynb     # Subtask 1, notebook 3, version 2
_2_1__1_cleanup.py     # Subtask 2_1, notebook 1
_2_2__1_sample_calls.py  # Subtask 2_2, notebook 1
```

All notebooks in one research directory — flat list, no nesting.

### Connection to task

The prefix `_m` links back to the subtask in `.task/NN_name/`.

### Numbering

`k` follows logical execution order (which notebook builds on which), not
creation time.

- New notebook gets a number strictly higher than notebooks it depends on.
- When repeating a step in a new context — copy the previous notebook, do not
  edit it. The new one improves where needed; the old one stays as history.

## Artifacts

Non-heavy artifacts (csv, yaml, ...) belong to
`notebooks/research_path/artifacts/`, which is versioned.

Heavy data files (parquet, large csv) live in gitignored
`notebooks/research_path/data.large/`

**DO NOT SAVE PLOTS as artefacts** The place for plots is notebook cell output
(inline).

Naming: prefix of source notebook + description:

```text
artifacts/
  _1__2_metrics.yaml         ← created by _1__2_eval.ipynb
data.large/
  _1__1_df_calls.parquet     ← created by _1__1_query.ipynb
```

Two-way traceability:

- Given artifact → grep prefix → source notebook
- Given notebook → find artifacts/ with prefix → its outputs

## Data paths

- Final outputs → `data.large/` or `artifacts/` (depending on versioning needs)
- Debug dumps, build logs, snapshots → `.tmp/` in the repo root (in .gitignore)
- **Do NOT write to `/tmp`** — any file there requires SCP to extract. `.tmp/`
  is free (no approval, no history).

## LOG.md

Each meaningful research step gets a journal entry.

**When to write:** step completed — ran, produced result, user confirmed
completion. Start of a step is not a reason to write. If a step is redone — new
entry, do not edit old.

**What to write:** hypotheses, results, choices between alternatives,
limitations found. Not: file paths, run commands, config details.

**Where:** `notebooks/NN_epic/LOG.md`. New entry at the bottom (chronological
past → present).

**Format:** date, essence, decision, rationale. No technical details.

## Script/notebook discipline

- All data in `data.large/` or `artifacts/` must be created by a numbered
  script or notebook.
- Exception: debug trash (logs, snapshots, temp dumps) goes to `.tmp/`.
- When manipulating data — use scripts, not inline operations.

## Notebooks

- Notebooks are `.ipynb`. NEVER read as raw JSON. Use `readnb` for viewing.
- Eval notebooks are documents that log insights and decision-making.
- MUST NOT fill / edit conclusions, this is user's prerogative.
- MUST NOT state conslusions upon running the notebook.

## Cell discipline

- **One cell = one meaningful output.** If a cell prints more than one table —
  split it.
- **Output at cell end:** `tldr(df)` for dataframes, `print(df.value_counts())`
  / `print(df.group_by)` / `print(df.pivot)` for summaries,
  `display(classification_report)` for metrics.
- **Look at data, don't work blind.** After `pl.read_csv()`, `query()`,
  `filter()`, `join()`, `group_by()` — first `tldr()`. Types, nulls, row count,
  uniqueness — visible immediately. No code that manipulates data without
  examining it.
