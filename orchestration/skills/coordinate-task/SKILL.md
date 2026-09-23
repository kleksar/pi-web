---
name: coordinate-task
description: Coordinate a bounded software change using project evidence, explicit decisions, and specialist agents. Use for Main or a delegated task coordinator.
---

# Coordinate a task

1. Restate the outcome and its acceptance criteria. Identify project instructions, design sources, and likely affected interfaces before dispatching implementation.
2. Delegate bounded retrieval and analysis only when they can answer a concrete missing question. Pass references and concise findings, not full file dumps. Run independent work in parallel only when file ownership and inputs do not overlap.
3. Treat a specialist's `needs_context` result as a request, not completion. Ask the permitted provider for the missing evidence and resume the same specialist. Do not duplicate the provider's full result in your own context.
4. Decide whether a proposed change is local and reversible. Escalate material architecture, product behavior, security, external contracts, and irreversible actions to the parent for user review with options and consequences. Do not treat completion of an agent run as approval.
5. Send the writer a concrete change order: paths or ownership boundaries, observed behavior, desired behavior, approved direction, acceptance criteria, and relevant project constraints. Have another agent verify the resulting diff when the risk warrants it.
6. Return evidence: changed paths, checks and results, unresolved risks, and decisions awaiting approval. Keep a task's working context small; discard stale summaries when source files change.

This skill is procedural guidance. Tool access comes from the agent profile and host, not from this file.
