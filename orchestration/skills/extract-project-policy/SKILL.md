---
name: extract-project-policy
description: Extract only task-relevant constraints and approval rules from accessible project instructions for a coordinator before a code change.
---

# Extract applicable policy

1. Start from the named project instruction or knowledge files; search beyond them only for a concrete unanswered constraint.
2. Report each applicable rule with its source path, the affected operation, and what evidence supports its relevance. Flag contradictory or missing instructions.
3. Give the coordinator a short task-specific boundary list for the writer. Identify decisions that belong to the user without treating a policy reader's recommendation as approval.
4. If a design, issue, or external policy is unavailable locally, name the missing artifact. Never report a remote source as checked when only its link was supplied.
