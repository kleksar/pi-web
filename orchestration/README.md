# Versioned sub-agents

Sub-agent profiles saved to the **Repository** scope in Pi Web live in
`orchestration/agents/*.md`. Edits, enable/disable switches and deletions are
ordinary Git changes in this checkout. Review and commit them to `develop`.
There is no automatic commit or push when saving a profile.

The shared Main dispatcher configuration lives in `main-dispatcher.json`.
The settings in `subagent-settings.json` are also versioned. Existing local
profiles and settings remain available; global profiles may override a
repository agent, and local settings may override individual repository values.
Project and workspace profiles with a repository agent's name are skipped.
Pi Web shows the effective settings sources. The ten
experimental task-orchestration roles are host-owned built-ins; their model,
tools and prompts remain in code to preserve the task boundary. They are not
editable Markdown profiles.
