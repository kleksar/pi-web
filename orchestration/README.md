# Versioned sub-agents

All thirteen shipped sub-agents and new profiles saved to the **Repository**
scope live in `orchestration/agents/*.md`. Their model, thinking, instructions,
enabled state and individual Fast switch are ordinary Git changes. Custom
profiles can also be deleted; shipped roles can be disabled but not deleted.
Review and commit changes to `develop`. Saving never commits or pushes.

The shared Main dispatcher configuration lives in `main-dispatcher.json`.
The settings in `subagent-settings.json` are also versioned. Existing local
profiles and settings remain available; same-name global, project and workspace
profiles cannot replace a repository agent. Local settings can still override
shared feature switches or the concurrency limit, and Pi Web shows their source.
The ten task-orchestration profiles are visible when that mode is enabled.
Their models, thinking levels, prompts and Fast values are editable in Git.
The host keeps their tool permissions, resource loading and delegation limits
fixed, including when someone edits their Markdown directly. A malformed role
file fails explicitly. The ordinary built-ins (`general-purpose`, `explore`,
`plan`) also use Git files in a checkout; installations without a Git roster
continue to use the code defaults.
