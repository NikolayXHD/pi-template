---
name: gantt
description:
  "Timeline visualization for complex epics — gantt metadata in subtask
  issue.md, Gantt chart rendering via pyCritical. Load for complex multi-step
  tasks needing dependency tracking."
---

You manage Gantt chart rendering and timeline planning for complex epics with
dependencies, critical path, and parallel streams.

# .task/ task tracking

Task tracking (.task/ structure, numbering, lifecycle, taxonomy) — skill
`issues`. Load it for any .task/ operation; this skill covers only the Gantt
timeline on top.

## Gantt metadata in issue.md

Gantt fields live in each subtask's `issue.md` inside a yaml code block with
`# gantt` comment:

````markdown
# QC human labels

Check labels: score < 0.01 and > 0.95, review 5-10 examples.

```yaml
# gantt
dur: 1
stream: Data
color: "#4C72B0"
depends_on: []
```
````

Fields:

| Field        | Type        | Description                                     |
| ------------ | ----------- | ----------------------------------------------- |
| `dur`        | `number`    | Duration in hours                               |
| `stream`     | `str`       | Group/stream name (Gantt groups by this field)  |
| `color`      | `str`       | Bar HEX color                                   |
| `depends_on` | `list[str]` | IDs of prerequisite tasks (FS+0). Empty if none |

Bar label in Gantt — first `#` heading in the same issue.md. Task ID — full
numeric prefix of the directory name (`1_sampling` → id=`1`; `2_1_sampling` →
id=`2_1`).

### Principles

- One subtask = one directory. Move the whole directory on state change.
- Full description lives in subtask issue.md; yaml block is Gantt-only.
- `# gantt` block is optional — without it the task is excluded from Gantt.

## Gantt rendering

```bash
~/.pi/agent/skills/gantt/gantt .task/current/NN_name
```

Output: `gantt.svg` in the epic directory. First run auto-creates venv and
installs `pycritical`.
