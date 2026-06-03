# Reference — feature-branch fan-in

## The seven gotchas (why they exist — don't simplify them away)

1. **Sub-PR base = feature branch, not main.** `gh pr create --base <feature-branch>`.
   The afk-task-runner defaults toward main; if you forget `--base`, the work
   bypasses the integration branch and lands on main one issue at a time,
   defeating the "consolidated landing" goal.

2. **"Addresses #N", never "Closes #N" on sub-PRs.** A `Closes #N` keyword on a
   PR that merges into the *feature* branch auto-closes the issue prematurely
   (before the work is on main). Use "Addresses #N" on sub-PRs; put `Closes #N`
   only on the final feature-branch → main PR, where closing is correct.

3. **Free the runner's worktree before the reviewer checks out the branch.**
   The afk-task-runner runs in an isolated git worktree that keeps its child
   branch checked out. Git refuses to check out the same branch in a second
   worktree, so the reviewer's `gh pr checkout <n>` fails with "branch already
   checked out". The branch is safe on origin (the PR is pushed), so:
   `git worktree remove --force <agent-worktree-path>` then `git worktree prune`.
   The agent's result includes its `worktreePath`.

4. **Pass the locked design into BOTH agents.** Hand each agent the issue's
   "design locked" comment + the relevant `CONTEXT.md` entry + ADR. Without it,
   the runner re-litigates settled decisions and the reviewer flags
   design-faithful code as "wrong". Tell both explicitly: the design is locked,
   implement/review against it, do not re-grill.

5. **Sequential-with-merge-between when issues share files.** If two issues edit
   the same files (e.g. a shared config struct + consumer), running them in
   parallel produces merge conflicts and the second agent is blind to the
   first's changes. Run sequentially and merge each into the feature branch
   before starting the next, so the next runner branches off the updated state.
   Independent issues may run in parallel (a single message with multiple Agent
   calls). When unsure: sequential.

6. **Squash-merge sub-PRs.** `--squash` keeps one tidy commit per issue on the
   feature branch instead of importing the agent's WIP + `RALPH: Review -`
   commits. The feature branch reads as one-commit-per-issue; the main PR is
   then a clean story.

7. **Assert the gh account up front.** For orgs with account routing (check
   memory/CLAUDE.md), run `gh auth switch -u <account>` before any gh call —
   and tell each spawned agent to do the same, since they run their own gh
   commands. A wrong default account 404s on private org repos.

## afk-task-runner prompt template

> Implement GitHub issue #N ONLY ("<title>") in <owner>/<repo>. Do NOT touch
> other issues' scope.
>
> The design is ALREADY LOCKED — do not re-design or re-grill. Read first:
> (1) `gh issue view N --repo <owner>/<repo> --comments` → the "design locked"
> comment is authoritative; (2) `CONTEXT.md` → <relevant entry>; (3)
> `docs/adr/<NNNN>.md`. Use gh account `<account>` for <org> — run
> `gh auth switch -u <account>` first.
>
> <Paste the locked design summary here.>
>
> TDD. Feedback loop must pass before PR: `go vet ./...`, `go test -race ./...`,
> `go build ./...` (adapt to the repo's toolchain).
>
> Branch + PR: base is `<feature-branch>` (your isolated worktree is branched
> from it). Work on child branch `<child-branch>`. Open the PR with
> **base = `<feature-branch>`** (NOT main). PR body: "Addresses #N" (NOT
> "Closes #N"). Do NOT close or modify the issue. Report the PR URL + the exact
> test result.

## code-reviewer prompt template

> Review open PR #<n> in <owner>/<repo>. Branch: `<child-branch>`. Issue: #N —
> "<title>". PR base: `<feature-branch>` (integration branch, NOT main).
>
> Setup: `gh auth switch -u <account>`, then
> `gh pr checkout <n> --repo <owner>/<repo>`.
>
> Review against locked intent AND correctness. Read the issue's "design locked"
> comment, `CONTEXT.md` <entry>, and the ADR. <List the high-value,
> design-specific checks — the things most likely to be subtly wrong.>
>
> Fix issues + write missing tests. Commit to `<child-branch>` with messages
> prefixed `RALPH: Review - `. Push so the PR updates. Feedback loop must pass
> after fixes. Return severity-tagged findings, commit SHAs, final test result,
> verdict (APPROVE / CHANGES MADE / BLOCKED-needs-human).

## Merge + cleanup commands

```sh
# free the runner's worktree (run from the main checkout / feature worktree)
git worktree remove --force <agent-worktree-path>
git worktree prune

# squash-merge the sub-PR into the feature branch
gh pr merge <n> --repo <owner>/<repo> --squash --delete-branch
git pull --ff-only origin <feature-branch>

# final consolidated PR
gh pr create --repo <owner>/<repo> --base main --head <feature-branch> \
  --title "..." --body "...Closes #23. Closes #24..."
```

## When NOT to use this skill

- A single issue → use the `afk-issue` skill (runner + reviewer + one PR, base
  main by default); no feature branch needed.
- Design not yet locked → run `grill-with-docs` first.
- No issues yet → `to-issues` first.
- Issues are fully independent and you want them straight on main → skip the
  integration branch; this skill's value is the consolidated landing.
