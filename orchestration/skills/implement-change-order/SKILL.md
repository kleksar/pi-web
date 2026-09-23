---
name: implement-change-order
description: Execute a coordinator-approved change order with bounded edits and targeted checks. Use for a writer assigned specific files and acceptance criteria.
---

# Implement the change order

1. Check the supplied file boundaries, acceptance criteria, and task-specific project constraints. Ask the coordinator to resolve a missing design decision or missing applicable constraint before changing files.
2. Read only the files needed for the implementation. Keep the change within authorized paths and preserve neighboring behavior.
3. Run targeted checks with the tools available to your profile. If a command or external verification tool is unavailable, report the unchecked item instead of claiming it passed. Report failures verbatim enough to reproduce them.
4. Return modified paths, checks and results, and any unresolved blocker or suggested follow-up. The coordinator decides whether to expand scope.
