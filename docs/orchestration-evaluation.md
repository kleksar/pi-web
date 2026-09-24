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
| Correct a local parser bug | Existing tests, affected symbol, project rules | One coordinator requests only necessary context, orders a bounded fix, verifies the behavior | Repeated repo-wide reading; an unrelated change; verification omitted |
| Resolve a mismatch between knowledge and code | Project knowledge and relevant implementation | Readers identify the contradiction with source references; coordinator asks for the owner of the intended behavior before editing | Treating older documentation as a fact about running code; silent choice |
| Update a frontend component owned by a design team | Requirement and an available design artifact or a pointer to obtain one | Source reader records the constraint; coordinator requests missing design evidence or a user decision before giving Writer an order | Writer improvises the design or claims to have inspected an inaccessible Figma file |
| Change an API or persisted schema | Clients, migrations, tests, project release rules | Analyst describes alternatives and blast radius; material choice reaches user; implementation and independent verification follow an approved order | Defaulting to a breaking contract, or starting Writer before the decision |

Repeat each scenario on a new Main session with an empty local profile/skill
catalog, running Pi Web from a reviewed Git checkout (or an installed server
with `PI_WEB_ROSTER_ROOT` pointing at that checkout). Record the
exact Git commit, active profile/skill revisions, model, thinking level, Fast
mode, provider, and project rules used. Compare with a single-agent baseline
under the same acceptance criteria; only promote a more complex workflow if it
improves the outcome enough to justify its added time and cost.

## Per-run measures

| Measure | How to observe it |
| --- | --- |
| Correctness and scope | Acceptance criteria, independent diff review, targeted tests and user review |
| Decision ownership | Whether a material choice was identified, presented, and approved before implementation |
| Evidence quality | Citations to inspected files/artifacts; explicit missing or contradictory sources |
| Efficiency | Total tokens/cost, elapsed time, count of agent runs, duplicate file reads, repeated handoffs |
| Reliability | Failed prerequisites, rejected context requests, retries, stale source references, changes outside the assigned boundary |

Start with a small set of real tasks before fixing model/effort defaults. Test
the supported combinations of model, thinking and Fast mode on the same cases;
the price and quality of a model can change independently of this repo. Keep
the number of *invoked* agents proportional to missing evidence and risk,
regardless of how many profiles are available in the catalog. The existing
runtime allows a maximum depth of three subagents below Main and caps root
descendants; the catalog cannot promise thousands of concurrent agents.

These are evaluation criteria rather than measured results. Relevant published
experience: [Anthropic on multi-agent cost and coding dependencies](https://www.anthropic.com/engineering/multi-agent-research-system),
[OpenAI on orchestration patterns](https://developers.openai.com/api/docs/guides/agents/orchestration),
and [OpenAI on agent evaluations](https://developers.openai.com/api/docs/guides/agent-evals).
