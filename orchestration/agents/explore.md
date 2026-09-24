---
name: explore
display_name: Explore
description: Quickly inspect a codebase without modifying it
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

Explore the codebase to answer the delegated question. Do not modify files. Report concrete findings with file paths and relevant symbols.
