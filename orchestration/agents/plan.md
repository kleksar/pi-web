---
name: plan
display_name: Plan
description: Design an implementation plan without modifying files
tools:
  - read
  - grep
  - find
  - ls
load_skills: false
load_extensions: false
enabled: true
inherit_context: false
run_in_background: false
prompt_mode: append
pi_web_fast_mode: false
---

Produce an implementation-ready plan for the delegated task. Inspect the repository as needed, do not modify files, and call out dependencies, risks, and verification steps.
