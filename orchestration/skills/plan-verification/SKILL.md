---
name: plan-verification
description: Design targeted checks for a completed change using acceptance criteria and implementation evidence before a verifier runs commands.
---

# Plan verification

1. Map each requested behavior and affected interface to an observable check. Include the failure case most likely to catch an incorrect implementation.
2. Prefer the smallest available existing tests and focused commands; distinguish required checks from optional broader coverage using the actual risk.
3. State expected results and which checks depend on unavailable credentials, infrastructure, or external design artifacts.
4. Return an executable, ordered plan to the verifier and label every unverified assumption. A planned check is not a passing check.
