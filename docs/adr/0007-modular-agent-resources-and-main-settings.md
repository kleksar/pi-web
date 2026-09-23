# 0007 — Per-agent resources and Main settings

## Status

Accepted for the modular orchestration increment.

## Context

The former `load_skills` and `load_extensions` flags let a sub-agent discover
every available skill or extension. A roster with many narrowly scoped agents
needs individual resource assignments. Main also needs its own editable
settings, independent of any child orchestrator. The orchestration graph must
describe the same configuration that runs, rather than maintain another copy.

## Decision

- Main has a **global** Pi Web configuration in
  `~/.pi/agent/main-agent-config.json`. It holds optional `selectedSkills`
  (exact `SKILL.md` paths), `selectedExtensionTools` (extension path plus tool
  name), and `orchestration` (direct child names and optional dependencies).
  The Main settings tab edits this file through a validated, revision-checked
  API. Main's `APPEND_SYSTEM.md` is edited separately: the effective trusted
  project file can shadow the global file.
- Each sub-agent keeps its own prompt, selected skills, selected extension
  tools, and orchestration in its existing Markdown profile. Resources and
  instructions **do not inherit** from Main or an ancestor orchestrator.
  Assigning one skill to several profiles references the same source file; it
  does not make copies. Main, orchestrator 1, and orchestrator 2 may therefore
  share a skill or use different ones. A **new UI-created profile** starts with
  `tools: []`, `selectedSkills: []`, `selectedExtensionTools: []`, and
  `inheritContext: false`; an existing profile keeps its saved settings until
  edited explicitly.
- Missing selection fields preserve the legacy load-all behavior for Main and
  the existing boolean flags for sub-agents. An explicit empty list means no
  selected resources. Changing a legacy profile to an explicit list is a user
  action; an unrelated save does not silently reduce its resources. Skills
  supply instructions, while selected extension tools become callable tools.
  The tool selection is **not a filesystem sandbox** or a credential boundary:
  a skill itself grants no tool, and a file-capable agent can still access
  ordinary files according to its other tool and host permissions.
- A skill's `SKILL.md` and supporting files remain authored outside this UI,
  including skills tracked in Git or reached through symlinks. The UI lists and
  assigns the discovered source; it does not copy or edit skill contents.
  The host checks selected sources against the effective SDK catalog and pins
  their content/source identity for a run. If a selected source disappears or
  changes, the run fails instead of substituting another skill or tool.
- A new Main session pins its configured resources and allowed direct child
  profile fingerprints. Reopening or reloading that session keeps the pinned
  assignments. Saving Main settings affects **new sessions**; old sessions
  without a Main snapshot retain their former behavior. Main config revisions
  protect simultaneous editors from overwriting each other. If the global
  config selects a project-only skill, extension, or child that is unavailable
  in another cwd, session startup or delegation fails closed there. A
  project-specific Main config overlay is outside this increment.
- `Main → orchestrator 1 → orchestrator 2 → specialists` uses each owner's own
  direct child list. `depends_on` is local to that owner and requires results
  from its direct producer children in the current invocation. Edges do not
  start agents automatically. The map presents delegation and dependency
  layers from the saved config; dragging nodes changes only their layout.
  Existing depth, active-descendant, Stop, result-artifact, and profile-pin
  rules remain as specified in ADR 0006.

## Consequences

The Main tab, profile editor, and map can edit or inspect the same effective
agent configuration without a second behavior store. Main's global assignments
must be chosen with each project in mind: a path or profile available in one
cwd is not guaranteed available in another. Explicitly selected resources
reduce a specialist's advertised context, but isolation still depends on the
agent's actual callable tools and host permissions.
