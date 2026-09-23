# 0009 — A repository-owned orchestration catalog

## Status

Accepted for the first versioned roster increment.

## Problem

Agent profiles and skills created only in `~/.pi/agent` are unavailable in a
clean checkout and cannot be reviewed with application changes. A profile in
one project's `.pi/agents` is invisible when Pi Web runs in another project.
Copying a repository's profiles into the global directory loses the connection
between what the UI edits and what Git tracks. Replacing the entire global
directory with a symlink would hide the operator's existing resources.

## Decision

- Store shared profiles in `orchestration/agents/*.md` and authored skills in
  `orchestration/skills/<name>/SKILL.md`. Load them as a separate `roster`
  source when `PI_WEB_ROSTER_ROOT` names the physical `orchestration` directory
  in a trusted checkout. This setting is made by the Pi Web operator, not by
  the workspace being inspected. It is optional for upstream installations.
- UI edits to a `roster` profile write its tracked Markdown source. Existing
  global, workspace and project profile directories remain separate. Skills
  can be assigned individually in the UI; their source is authored with a
  normal editor and tracked in Git. Do not publish an operator's unknown
  existing local profiles or skills automatically.
- In a roster profile, a selected skill is named relative to the roster root,
  such as `skills/coordinate-task/SKILL.md`. Resolve through physical paths,
  reject traversal and symlink escape, and pin the selected skill's identity
  and contents for each run. The same relative convention applies to a
  project's own `.pi/agents` and `.pi/skills`.
- Discover roster skills for assignment regardless of the currently selected
  agent; give them to a running agent only if its effective skill switch is on.
  The SDK loads `additionalSkillPaths` even with `noSkills: true`, so this
  conditional is necessary to keep unrelated skills out of agent context.
- Roster skills and any links inside their catalog must stay within the
  operator-configured roster root. Skills independently installed in global
  Pi directories may still be referenced by personal settings; bringing an
  external skills repository into the shared catalog requires an explicit
  trusted-root design rather than an unchecked symlink.
- Existing project trust checks still govern project-owned resources. A
  repository roster is explicitly enabled by the server operator and is not
  selected from an untrusted project's configuration.
- A profile's `allowed_children` describes *who may be delegated to*;
  `depends_on` describes *which result must already exist*; `context_providers`
  describes *who can answer a later request for missing evidence*. A graph edge
  never starts another agent by itself. New agents default to no inherited
  parent conversation. A skill conveys instructions and grants no tools.

## Boundaries and follow-up

The sample catalog is a coherent starting policy for a single bounded change,
not a benchmark claim about model quality. Set actual model IDs and Fast mode
through the UI after checking which authenticated models support them. Main's
global settings may override shared defaults, and a trusted project's
configuration can override both. New sessions pin what they see; editing the
catalog does not silently change an active session. Tool checkboxes and agent
instructions do not constitute an OS-level permission sandbox; host credentials
and the command tool still matter. The runtime pins `SKILL.md` content but does
not yet pin every supporting file in a skill directory.

An actual historical roster must be inventoried, redacted and intentionally
imported by its owner before commit to a public repository. This checkout has
no access to the operator's original local files.

## Branch ownership

`upstream/main` is the official Pi Web branch. The personal fork's `main` is
only a fast-forward mirror of that branch. Features and the catalog land on
`develop` through review; a sync rebases `develop` onto the mirrored main.
Rebasing a published branch changes commit IDs and invalidates branches based
on the old history: perform it in an exclusive maintenance window using
`--force-with-lease`, then update dependent feature branches and open PRs.
Never merge `develop` into the mirror branch. Before pushing any local user
resources to the public fork, inspect them for private content and credentials.
