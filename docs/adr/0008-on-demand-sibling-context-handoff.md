# 0008 — On-demand context between sibling agents

## Status

Accepted for the orchestration map increment.

## Context

`depends_on` means a producer must finish successfully before the consumer can
start. That prevents an Analyst from beginning with a small brief, identifying
missing files, and then asking a Reader for only those files. Sending the
Reader's full answer through a coordinator also wastes the coordinator's
context window.

## Decision

- `contextProviders` is a separate optional consumer-to-provider graph of
  direct children in each Main or sub-agent orchestrator policy. It is stored
  as `context_providers` in a profile's `pi_web_orchestration` frontmatter.
  Names are canonicalized to allowed children; each consumer has at most eight
  unique sources across context providers and strict prerequisites combined.
  Self edges, duplicate names, and cycles across both
  `contextProviders` and strict `dependencies` are rejected.
- A specialist listed as a context consumer may return one standalone JSON
  object: `{"status":"needs_context","provider":"Reader","request":"Which
  files implement X?","missingFiles":["src/x.ts"]}`. `missingFiles` is optional.
  Pi Web adds a short system instruction naming the permitted providers to
  that specialist. The specialist has no delegation tool. Malformed explicit
  requests or requests for providers outside its pinned policy fail the run.
- The host reports `needs_context` with the requester session ID and the
  bounded request to its parent. The parent explicitly starts the requested
  provider with `Agent(subagent_type="Reader", context_for="<requester ID>",
  prompt="<request>")`. The provider's response is stored in its own
  inspectable session. `Agent`, `get_subagent_result`, and background
  notifications show only a handoff reference to the parent, without the
  provider's full text.
- The parent explicitly resumes the requester using `Agent(resume="<requester
  ID>", prompt="Continue")`. Pi Web verifies the source session and its
  latest completed result, then appends that result directly to the
  requester's prompt. Both sessions must be direct siblings under the same
  parent path, pinned policy, and current invocation. The provider is bound
  to the exact request result entry; the source result ID and hash are
  checked again before the agent loop. A consumed handoff cannot be replayed.
  A provider can itself request another allowed sibling, then resume and
  finish the original handoff.
- `needs_context` is an intermediate result, never a successful dependency
  artifact. A Writer with `dependencies.Writer=["Analyst"]` remains blocked
  until Analyst returns a final completed result. Nested agents run in
  foreground even when their profile's default is background; explicit nested
  runtime overrides remain prohibited. Context results are limited to 64 KiB
  and request text to 4 KiB.

## Consequences

The map can distinguish a strict prerequisite from an on-demand context edge.
Coordinators see the provider name, request, and session handles while the
full Reader output goes directly from the host to the resumed consumer.
Main sessions and nested orchestrators pin their policies at creation; old
sessions without `contextProviders` gain no implicit provider permissions.
