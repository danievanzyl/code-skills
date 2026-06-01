# BEFORE STARTING

Use /caveman skill
Use /terraform-best-practices skill

# ISSUES

Local issue files from `issues/` are provided at start of context. Parse them to understand the open issues.

You will work on the AFK issues only, not the HITL ones.

You've also been passed a file containing the last few commits. Review these to understand what work has been done.

If all AFK tasks are complete, output <promise>NO MORE TASKS</promise>.

# TASK SELECTION

Pick the next task. Prioritize tasks in this order:

- Critical bugfixes
- Shell script testing infrastructure

  Getting test infrastructure like shellcheck, bats/shunit2, and dev scripts ready is an important precursor to building features.

- Tracer bullets for new features

  Tracer bullets are small slices of functionality that go through all layers of the system, allowing you to test and validate your approach early. This helps in identifying potential issues and ensures the script handles edge cases properly before investing significant time in development.

  TL;DR - test a tiny, end-to-end slice of the script first, then expand coverage.

- Polish and quick wins
- Refactors

# EXPLORATION

Explore the repo.

# IMPLEMENTATION

Use /tdd to complete the task.

# FEEDBACK LOOPS

Before committing, run the feedback loops:

- `shellcheck` (or `npx shellcheck`) to lint shell scripts
- `bats` or `shunit2` test suites (or whichever test framework is in use)
- Run the script itself in dry-run or with minimal input to verify basic execution

# COMMIT

Make a git commit. The commit message must:

1. Include key decisions made
2. Include files changed
3. Blockers or notes for next iteration

# THE ISSUE

If the task is complete, move the issue file to `issues/done/`.

If the task is not complete, add a note to the issue file with what was done.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
