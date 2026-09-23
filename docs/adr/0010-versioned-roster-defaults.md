# 0010 — Versioned Main prompt and delegation defaults

## Status

Accepted for the next roster increment on #2.

## Decision

The operator enables the shared Git catalog with `PI_WEB_ROSTER_ROOT` pointing
to a trusted `orchestration/` checkout. It contains the default Main policy,
`APPEND_SYSTEM.md`, the default built-in sub-agent switch and concurrency
settings, agent profiles, and selected skill sources. An agent profile, Main
prompt or delegation setting edited in the **Repository** scope of Pi Web
changes this checkout and must be reviewed, committed and published to become
a shared default. There is no automatic Git commit on Save.

Precedence for the Main prompt is trusted project `.pi/APPEND_SYSTEM.md`, then
operator-local `~/.pi/agent/APPEND_SYSTEM.md`, then the repository prompt. An
empty local prompt still shadows the repository text. Sub-agent settings are
merged by key: an explicitly set local key overrides the repository key, then
the built-in default. Global Main configuration overlays repository Main
configuration, and trusted project Main configuration overlays both. Local
sources are explicit experiments and the UI must show the effective source;
save actions for shared policy must write to the tracked repository file.

Projects may extend the catalog after trust. An untrusted project's profile
with the same ID as a repository profile cannot silently replace that shared
profile; trusted project overrides and operator-local overrides are visible in
the existing source list. Existing sessions keep their pinned policy and
resources; start a new session to test a changed catalog.

The roster's 16 profiles and seven skills represent differentiated roles and
tools, not a prescribed number of simultaneous model calls. Small, medium and
complex coordination paths share the same role skills. A decision request
raised by an agent is guidance for the Main/user interaction; no technical
approval gate is introduced by these Markdown instructions.

## Migration and limitations

Historical local profiles and skill repositories were not available for
inspection when this catalog was written. A read-only preflight checks local
resources, Git publication and deliberate replacements. A separate reversible
test from the user's machine must confirm runtime behavior without the old
local sources before deletion. Local authentication, model credentials and
session records are runtime state and do not belong in this public Git repo.

`PI_WEB_ROSTER_ROOT` is an operator configuration, independent of the task
project. A versioned skills catalog currently rejects links that escape its
physical root; external skills repositories require a separate reviewed
reference mechanism. File tools and shell availability are capability choices
in the application, not an OS sandbox. The runtime currently limits nested
depth and concurrent descendants, so measured task quality, latency and cost
must guide any later expansion.
