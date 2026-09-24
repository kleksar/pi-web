# 0006 — Opt-in task-scoped orchestration

## Status

Experimental. Default Pi Web sessions and their existing agents retain their behavior.

## Context

A long-lived expensive Main pays for every follow-up and background completion.
Routing every file search and edit through a strong model also spends its context
on mechanical work. Conversely, a cheap reader can omit a decisive condition,
and repeated cheap-writer/reviewer loops can cost more than one direct strong
model run. Model prices and capabilities change; the quality and cost of an
entire accepted task matter more than a profile's token price.

## Decision

An explicitly enabled Main session uses Luna High Fast as a lightweight
dispatcher. It can delegate an engineering task only to an Astra High task
owner. The owner plans and decides, fans out independent narrow Luna High Fast
readers, and can directly inspect exact sources when their reports are
incomplete. A Luna High Fast package writer applies a host-checked literal
patch only within paths and a worktree snapshot pinned at dispatch. The host
also pins the applicable root and nested `AGENTS.md` fingerprint. Astra High
reviews the actual candidate independently. Sol is a future *binding* for
evaluated bounded task classes, not an automatic quality fallback in this
first experiment.

Seven reader contracts cover project rules, documentation, code, tests,
dependencies, specified external sources, and runtime evidence. They may run
in parallel and return task-scoped evidence references. The host attaches
saved original source excerpts to the batch result so the owner can check
a reader's paraphrase against them. An owner can use bounded direct source reading
and search to investigate a missing path. Tools for Git snapshots, exact
checks, and bounded patch application belong to the host, not another agent
role. This produces ten opt-in child profiles plus Main without a fixed
agent-to-agent DAG.

The host records the literal original user request and project instructions
inside each task. Before the owner runs, it captures a pinned baseline of
Git-visible index and dirty/untracked files, including literal saved bytes
up to 4 MiB per file. A candidate manifest separates prior user changes
from task changes. The reviewer must page through the complete manifest and
the literal bytes of affected untracked files before an approval. The owner
runs exact project checks; the host retains full logs and their actual status.
The host reads later real user messages from Main before candidate capture
and acceptance. Owner and reviewer must fetch them through
`read_task_steering`; new messages invalidate earlier approval before owner
steering is delivered. The opt-in route rejects original user messages with
attachments until their content can be delegated faithfully.

Acceptance requires the unchanged candidate, an independent approval for
the same criteria revision, reviewer-required checks passed on that
snapshot, and no unresolved blockers. Editing after review invalidates it.

Readers share a task queue with a reserved owner lane and an in-process
global concurrency cap, so a waiting owner does not consume a reader slot.
Writer mutations are serialized per worktree and revalidate the snapshot
immediately before applying. Multiple disjoint writers against one old
snapshot are retried sequentially; they are not concurrent writes. One
background batch can collect several reader results without waking the
owner for each report.

The UI exposes the opt-in when creating a session and lists the experimental
profiles separately in Agents. Agent sessions are individually inspectable.
The cost display includes each child and the session family; task cost is
attributed to children because Main's shared spend crosses task boundaries.
Missing usage is marked incomplete, and provider billing remains authoritative.
Agent identities, role tools, Fast setting, and task scope persist on reopen.

## Boundaries and evaluation

- The patch gate blocks path escapes, unlisted paths, symlinks, ignored paths,
  and Git `assume-unchanged`/`skip-worktree` paths. Snapshots cover Git-visible
  state, not every ignored file or external process. External edits require
  optimistic revalidation; in-process writer locks do not coordinate multiple
  Pi Web server processes.
- `run_check` starts an executable with exact argv and no shell expansion,
  but arbitrary project checks can themselves change files. The owner is a
  trusted execution role, not an operating-system sandbox. A changed
  Git-visible worktree invalidates the check's snapshot for acceptance.
- Native SDK `read`/`grep`/`find`/`ls` tools in these profiles can inspect
  paths outside the worktree. Host evidence references are scoped, but
  agents are trusted local readers. The SDK also converts background custom
  notifications to model user-role content; the runtime labels their origin,
  while patch and acceptance gates enforce mutations and approval.
- Sources over the evidence limit, unavailable original bytes, and required
  checks that could not run are explicit blockers; the host does not turn
  incomplete coverage into a passing result.
- A passing gate demonstrates provenance, completed checks, and independent
  review. It does not prove that a model found every semantic defect or that
  this route matches an all-Astra run. No live provider quality/cost trial is
  included in this implementation.

Before routing known task classes to Sol or increasing reader concurrency,
compare matched tasks against a direct Astra owner baseline. First vary only
source retrieval (direct Astra reading versus Luna readers plus original
source hydration); hold writer and reviewer policy constant. Record accepted
task cost, retries, time to accepted result (median and tail), review
findings, escaped defects, and missing coverage. Later evaluate full routes.
Keep model bindings configurable through profiles; change architecture only
when the task-level evidence warrants it.
