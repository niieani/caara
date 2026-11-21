# Triage Labels

The skills speak in terms of five canonical triage roles. Vault Task notes carry no labels: each
role maps to the Task's `assignee` and `status`.

| Role              | Task note                                                                   |
| ----------------- | --------------------------------------------------------------------------- |
| `needs-triage`    | Not a Task yet: propose it to Bazyli, who decides whether it is work        |
| `needs-info`      | `status: needs-input`; the question goes to Bazyli                          |
| `ready-for-agent` | `assignee: "[[Julian]]"`, `status: todo`                                    |
| `ready-for-human` | No `assignee` (Bazyli does it), `status: todo`, with a `due` or `schedule-at` reminder path |
| `wontfix`         | `status: dropped`, the reason in the body                                   |

When a skill applies a role, set the matching properties.
