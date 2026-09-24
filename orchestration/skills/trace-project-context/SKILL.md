---
name: trace-project-context
description: Retrieve narrow, cited code and project guidance for a delegated question. Use when a coordinator needs evidence without sending full files.
---

# Trace project context

1. Use cited project guidance already supplied by the coordinator. Read further guidance only when it applies to this retrieval question and was not supplied; inspect the specific target area before widening the search.
2. Return a compact source index: path, relevant symbol or range, why it matters, and any observed contradiction between code, tests, documentation, or design.
3. Provide only the decisive snippets or findings needed to answer the question. Never return whole files as context; a provider result must fit the host's 64 KiB limit, and a short cited summary costs fewer tokens. Label assumptions and unresolved questions. Never represent an uninspected source as verified.
4. If files are large or numerous, return the smallest set of concrete retrieval targets for the next pass.
