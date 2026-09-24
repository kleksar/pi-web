# 0006 — Controlled nested sub-agents

## Status

Accepted for the first nested orchestration increment.

## Context

Pi Web previously removed `Agent`, `get_subagent_result`, and
`steer_subagent` from every child session. This prevented an orchestrator from
delegating work and made a prompt-only exception unsafe: the same tools could
then appear on ordinary specialists, including after a session was reopened.

## Decision

An agent profile can opt into delegation in its existing Markdown frontmatter.
For example, `.pi/agents/feature-coordinator.md`:

```yaml
---
name: feature-coordinator
description: Coordinate one feature
tools: none
load_skills: false
load_extensions: false
run_in_background: false
pi_web_orchestration:
  kind: orchestrator
  allowed_children:
    - project-reader
    - code-analyst
    - code-worker
  depends_on:
    code-analyst: [project-reader]
    code-worker: [code-analyst]
---
Delegate only to the listed specialists. Report blockers to the parent.
```

- A functioning orchestrator has no file, extension, or skill tools. Its only
  active tools are Pi Web's inline `Agent`, `get_subagent_result`, and
  `steer_subagent`. The runtime checks that the host extension registered all
  three without another extension claiming them before creating the session.
  A specialist receives none of these reserved tools, even if another loaded
  extension declares the same names. A malformed orchestration policy disables
  that profile instead of silently granting ordinary tools.
- A child can start only a profile named in its own `allowed_children` list.
  `Agent` advertises that local list; the runtime checks again for direct calls
  and resumes. `get_subagent_result` can inspect only a direct child of its
  caller, and `steer_subagent` rejects other sessions. A resumed child must
  still belong to the same parent.
- At child creation, the `pi-web:subagent` session entry stores a version 2
  resource snapshot: selected tools, prompt/resource switches, allowed child
  names, root session ID, depth, and a fingerprint for each effective allowed
  profile (scope, path where applicable, and SHA-256 of runtime-relevant
  fields). Reopen reads this snapshot rather than granting tools from today's
  parent profile. If an allowed target is disabled, removed, shadowed, or
  changed under the same name, a new dispatch fails before loading services
  or creating a child. Refreshing that target requires a new orchestrator
  session; an existing run does not silently change its authorization.
- Maximum child depth is **3** (`root → child` is depth 1). A profile cannot
  invoke itself or an ancestor in the same branch. A root may have at most
  **32 admitted descendants** across its active tree; queued and running
  children count. Waiting parents do not consume their children's per-parent
  queue slots. This is a session count limit, not a token or time budget.
- Nested children (depth 2 or 3) run in the foreground and cannot create a
  separate worktree. A depth 1 branch may use its existing isolated worktree;
  its nested children share that cwd. During Stop, Pi Web blocks new starts,
  cancels queued and running descendants recursively, waits for child
  finalization before worktree cleanup, and suppresses pending background
  completion notifications. A later accepted prompt can allow new starts.
- `depends_on` is an optional mapping from a consumer child to its required
  producer children. Every name must be in `allowed_children`; duplicate edges,
  self-dependencies, and cycles are rejected when the profile is saved and on
  session restoration. The configured graph is pinned with the orchestrator
  snapshot. A child with unmet prerequisites cannot start or resume. The
  orchestrator calls its producers explicitly; completion alone does not launch
  the next child.
- Pi Web records each completed producer's nonempty text as a host-owned
  `text.v1` artifact in the parent orchestrator's session, scoped to its current
  invocation. A consumer receives its required texts directly in its task,
  without the orchestrator copying payloads into a tool call. A failed, empty,
  aborted, or previous-invocation result cannot satisfy a dependency. Starting
  a producer again invalidates its previous result and downstream results in
  that invocation. The same profile has one active invocation at a time in the
  branch, and a producer cannot restart while a dependent child is active.
  Each producer result is limited to 64 KiB of UTF-8 text. Existing profiles
  without `depends_on` retain their behavior.
- A subagent can be continued through its parent `Agent(resume=...)` call.
  Direct RPC prompts, model/tool changes, and branch navigation on its session
  are rejected so they cannot bypass the dependency gate or tree Stop.

The built-in sub-agent feature switch still gates the extension and dispatch.
Legacy version 1 resource snapshots remain valid **as specialists** and never
gain delegation from a newly edited profile. Invalid session snapshots fail
closed on reopen. Markdown profiles remain the authoring source; the session
snapshot is the authority for an existing run.

## Scope

This increment enables a bounded nested invocation path and a single fixed
`text.v1` result contract for manual dependencies. Custom output schemas,
semantic acceptance, a graph editor, configuration revisions, and token/cost
accounting are separate work. `completed` still reports execution completion,
not acceptance of a feature's requirements.
