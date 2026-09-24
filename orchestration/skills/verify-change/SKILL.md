---
name: verify-change
description: Independently inspect a changed diff and run targeted non-destructive checks against supplied acceptance criteria.
---

# Verify the changed result

1. Compare changed paths with the authorized change order and expected behavior. Check for omitted cases, unintended changes in affected interfaces, and new duplication or coupling that makes this change harder to maintain. Give a specific finding to the coordinator when an improvement exceeds the authorized scope; do not silently expand the change.
2. Run the named focused checks available in the project. Capture the command, outcome, and decisive failure text; do not treat missing tests as passing.
3. Report evidence by acceptance criterion: passed, failed, or not checked. State whether source and project instructions disagree.
4. Return concrete findings to the coordinator. Verification is evidence for the user or parent, not an approval to merge or publish.
