---
name: review
description: Render review context for the current branch and dispatch the code-reviewer subagent. Usage `/review <issue-number> "<issue-title>"`.
argument-hint: <issue-number> "<issue-title>"
allowed-tools: Bash(git:*), Bash(gh:*)
---

Dispatch the `code-reviewer` subagent with the following context already gathered:

**Branch**: !`git rev-parse --abbrev-ref HEAD`
**Issue**: $ARGUMENTS

**Recent commits**:
!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

**Issue details**:
!`gh issue view $1`

**Diff vs main**:
!`git diff main..HEAD`

Tell the subagent: the branch, issue number, and issue title are above. Proceed with the standard review process from your system prompt.
