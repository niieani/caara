# Panel orchestrator adjudicates without reading panelist artifacts

The panel skill splits the end of a strategy run into two jobs: synthesis (reading every panelist's
work and consolidating the correct reasoning) is a delegable panel seat, while adjudication (the
final accept-or-iterate call and dissent accounting) is the orchestrator's and non-delegable. The
orchestrator must not open panelist artifact paths: it adjudicates from the synthesis artifact,
routing summaries, and mechanical verification (existence, size, diff presence, test runs) only.

The tradeoff is context economy over direct oversight. An orchestrator that reads every panelist
artifact spends a large share of its context window on one step, degrading all orchestration that
follows — and models that see a file path tend to eagerly read it, polluting their context and
pre-biasing the final call before synthesis has spoken. Treating artifact paths as opaque handles
keeps the orchestrator cheap, neutral, and able to run many-step sessions.

The synthesis seat is placed by two tests: context budget (terminal run with small inputs → the
orchestrator synthesizes inline, and only then may it read artifacts; otherwise a cold-briefed
synthesizer subagent) and output shape (prose-quality deliverables seat a model family that writes
well, regardless of the default). Oversight is not lost, it is restructured: integrity is checked
mechanically, hollow agreement is pressed via the anti-laziness probe, and open items must carry
lineage to specific dissent — all verifiable without content reads.
