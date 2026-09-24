# Local release smoke for the Git orchestration roster

Run these checks from the exact branch/commit under review, before merging it
into `develop`. Keep the fork's `main` as the upstream mirror. `orchestration/`
is the versioned source for Main, profiles, and skills; session history and
credentials are separate local data.

## Start and discover

1. Stop any existing Pi Web process on port 30141. From the reviewed Pi Web
   checkout, run `npm run dev`. A separately installed npm package instead
   needs `PI_WEB_ROSTER_ROOT=/absolute/path/to/checkout/orchestration` at launch.
2. With **no existing sessions**, open Settings → Sub-agents, Main, and Skills.
   They should work without selecting a project. Sub-agents should report a
   connected Git roster with **16 repository profiles** (and three built-in
   profiles); Skills should show **7 read-only
   Git skills**; Main should offer the repository policy and prompt. A missing
   roster should show an explicit connection instruction. A temporary default
   working directory used for browsing settings is not a trusted project.
   If a very large prompt, profile, selected skill, or Main configuration is
   rejected, reduce the source file instead of bypassing the bounded reader.
3. Search for a profile/skill, open the orchestration map, pan and zoom, and
   inspect a child coordinator and its readers. Confirm that the graph's
   delegation, strict prerequisite, and requested context links have distinct
   meanings. Empty or invalid concurrency values should revert to the saved
   value instead of appearing saved.
4. Create a new session in a chosen project. Check the provider is authenticated
   separately; deleting `~/.pi` can remove local session/model configuration.

## Exercise actual work

Use the cases in [orchestration-evaluation.md](orchestration-evaluation.md),
recording the Git commit, model, thinking level, Fast mode, provider, and
project policy for every run. Start with a small targeted fix, a medium task
requiring missing context from a reader, and an API/design decision with a
large blast radius. Verify the Writer receives a bounded change order and the
independent Verifier checks the diff. Reopen a Main and child session to check
that pinned profiles and skills still resolve; try a child `max_turns` limit
across start and resume. Use Fast mode only on a supported model/provider.

For any material architecture, contract, or design choice, the operator must
review the alternatives **before** asking agents to implement one. A completed
Analyst or Reviewer response saying “approval needed” currently does **not**
create a runtime approval gate: dependency edges verify a completed result,
not a human decision. Do not use this workflow for unattended changes that
require technical approval or operating-system file isolation.

## Record speed and cost honestly

For each case, compare against a single-agent run with the same acceptance
criteria. Record wall time, failures, number of spawned agents, duplicate file
reads, and the session statistics for Main **and each child**. Current Pi Web
does not aggregate a whole task tree automatically. JSONL usage omits some
extra requests (for example automatic title generation), and the displayed
Fast mode cost may differ from provider billing. Treat summed session costs
as an estimate; never label a static agent-count scenario a measured model
benchmark. Re-run a representative task after changing a role/model/skill.

Finally, verify `git status --short` contains only intended repository-owned
edits. Changes made in Settings to the Repository scope still need review and
commit; local overrides can shadow Git defaults.
