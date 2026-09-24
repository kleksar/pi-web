---
name: assess-architecture
description: Assess a proposed software change using supplied project evidence when interfaces, ownership, security, data, or maintainability may change.
---

# Assess the proposed architecture

1. Name the observed change and the citations supplied for current behavior; mark unknowns instead of filling them from convention.
2. Identify affected contracts, module boundaries, data flow, security properties, migration, rollback, and maintainability only where relevant. Flag growing coupling or duplication with a concrete source rather than assuming a file's length alone requires refactoring.
3. Present a small set of viable options with measurable costs and verification needs. Separate local reversible work from material choices that require the user's direction.
4. Return a concrete recommendation or a precise missing-evidence request to the coordinator. Do not authorize the writer or claim the user has approved an option.
