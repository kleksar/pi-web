# Evaluating the versioned orchestration roster

The catalog under `orchestration/` contains available roles, not a mandatory
pipeline. The Main session chooses a coordinator after checking the **impact,
uncertainty, and project constraints** of the request. A small diff can require
a complex review when it changes a public contract or a design owned elsewhere.
Selecting a tier never grants approval to make a material product or
architecture decision.

## Scenarios to rehearse

| Task | Evidence to supply | Expected behavior | What would count as a failure |
| --- | --- | --- | --- |
| “Расскажи об этом проекте” | Project Git checkout with documentation and code | Main delegates to evidence coordinator; it requests only needed docs and code evidence from readers and returns a cited overview | Main calls file/shell tools itself, or a reader invents the implemented state from docs alone |
| Correct a local parser bug | Existing tests, affected symbol, project rules | One coordinator requests only necessary context, orders a bounded fix, verifies the behavior | Repeated repo-wide reading; an unrelated change; verification omitted |
| Resolve a mismatch between knowledge and code | Project knowledge and relevant implementation | Readers identify the contradiction with source references; coordinator asks for the owner of the intended behavior before editing | Treating older documentation as a fact about running code; silent choice |
| Update a frontend component owned by a design team | Requirement and an available design artifact or a pointer to obtain one | Source reader records the constraint; coordinator requests missing design evidence or a user decision before giving Writer an order | Writer improvises the design or claims to have inspected an inaccessible Figma file |
| Change an API or persisted schema | Clients, migrations, tests, project release rules | Analyst describes alternatives and blast radius; material choice reaches user; implementation and independent verification follow an approved order | Defaulting to a breaking contract, or starting Writer before the decision |
| Analyst discovers an unavailable code path mid-analysis | Initial brief without the implementation path; a specific question the code reader can answer | Analyst returns `needs_context`; coordinator calls the permitted code reader with `context_for`, then resumes that same analyst. The host passes the reader's full answer directly to the analyst | Analyst invents files, the coordinator repeats the full source, or a new analyst replaces the waiting session |
| Add a feature across authentication, persistence, and UI | Applicable project policy, local requirements and design artifact, existing contracts, tests | Complex coordinator gathers only missing evidence, presents consequential choices to Main, gives each writer disjoint files, and verifies affected contracts | Parallel writes to the same files; an implementation before the choice; verification based solely on writer's report |
| Implement two independent feature requests at once | Acceptance criteria, distinct owners, affected file sets | Main starts separate coordinator branches only if edit ownership does not overlap; when ownership overlaps, sequence the changes or explicitly isolate the branches | Undetected concurrent edits or merging conflicting results as if both were verified |

## Expected routing before live trials

This is a dry-run of the **configured graph**, not a measured performance or
quality result. Counts refer to child runs below Main; a request/resume of the
same child or a retry adds further model turns. An edge permits a call; no
configured edge starts a child automatically.

| Case | Planned route and depth below Main | Child runs to budget initially | Block or escalate |
| --- | --- | ---: | --- |
| Narrow parser fix with cited project rules, exact path, and acceptance test | Small coordinator (1) → bounded writer, change verifier (2) | 3 | Expand if observed behavior or interface differs from the supplied order. A missing policy or code fact adds only the needed reader. |
| Knowledge says one behavior, code implements another | Task coordinator (1) → docs reader, code reader, technical analyst (2); writer and verifier only after a decision | 4 before decision; 6 if editing | Main asks who owns the intended behavior; neither source wins by default. A policy reader or context handoff adds runs only if needed. |
| Cross-component contract change with supplied requirements and unresolved architecture | Complex coordinator (1) → evidence, analyst, architecture reviewer, implementation, verification coordinators (2) → narrow readers, writers, test planner, verifier (3) | Up to 14 with four evidence readers, two writers, planner, and verifier | Main obtains the material decision before implementation. If the only design input is a Figma link, stop until its content is inspected or supplied. |

The complex profile requires successful analyst and architecture-reviewer
results before starting implementation, and successful implementation before
starting verification. Verification requires the test planner before its
verifier. These prerequisites are stronger than prompt wording. Select the
task coordinator for a smaller change when a full complex route adds no
information; never bypass required dependencies inside a selected route.
Reader outputs should be short cited findings, not entire source files. The
runtime caps each dependency or context provider result at 64 KiB and the
combined dependency input to one child at 512 KiB; those are safety bounds,
not target context sizes.

Repeat each scenario on a new Main session without local profile/skill
overrides, running Pi Web from a reviewed Git checkout (or an installed server
with `PI_WEB_ROSTER_ROOT` pointing at that checkout). Record the
exact Git commit, active profile/skill revisions, model, thinking level, Fast
mode, provider, and project rules used. Run the same scenario with a single
agent as a baseline; hold the acceptance criteria and available source
artifacts constant. Record results for repeated runs, including failures, not
only the best run. Only promote a more complex workflow if its improvement
justifies added time and cost.

## Per-run measures

| Measure | How to observe it |
| --- | --- |
| Correctness and scope | Acceptance criteria, independent diff review, targeted tests and user review |
| Decision ownership | Whether a material choice was identified, presented, and approved before implementation |
| Evidence quality | Citations to inspected files/artifacts; explicit missing or contradictory sources |
| Efficiency | Total tokens/cost, elapsed time, count of agent runs, duplicate file reads, repeated handoffs |
| Reliability | Failed prerequisites, rejected context requests, retries, stale source references, changes outside the assigned boundary |

For each run record timestamps at Main start and final verified response,
model/provider usage for **each** session (including child sessions), and the
effective billing rate at run time. Count tokens from provider usage once per
session, including cache reads/writes if available; do not confuse Main's
displayed statistics with a guaranteed sum for the entire agent tree. Record
wall-clock latency rather than adding overlapping child durations. Mark
missing usage or prices as unknown instead of treating them as zero.

Before tuning model, thinking, or Fast settings, require zero unauthorized
file changes and zero claims of inspecting inaccessible artifacts. Compare
pass/fail of the same acceptance checks, the number of human decisions
surfaced at the right time, median end-to-end latency, and median total cost
across repeated runs. Include a failure or contradiction case so a faster but
less reliable route cannot win by finishing early. Change one setting at a
time and repeat the same scenario set; do not infer a model's quality from one
successful example.

Start with a small set of real tasks before fixing model/effort defaults. Test
the supported combinations of model, thinking and Fast mode on the same cases;
the price and quality of a model can change independently of this repo. Keep
the number of *invoked* agents proportional to missing evidence and risk,
regardless of how many profiles are available in the catalog. The existing
runtime allows at most three subagent levels below Main and 32 admitted
descendants per root; the roster currently sets shared concurrency to 10.
The catalog cannot promise thousands of concurrent agents.

These are evaluation criteria rather than measured results. Relevant published
experience: [Anthropic on multi-agent cost and coding dependencies](https://www.anthropic.com/engineering/multi-agent-research-system),
[OpenAI on orchestration patterns](https://developers.openai.com/api/docs/guides/agents/orchestration),
and [OpenAI on agent evaluations](https://developers.openai.com/api/docs/guides/agent-evals).
