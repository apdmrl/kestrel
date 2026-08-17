# Architecture

Kestrel is one npm package and one CLI process, internally separated into layers with enforced import boundaries:

- **domain** — pure models, invariants, policies, and recommendation signals.
- **application** — task-oriented use cases.
- **ports** — external-boundary interfaces.
- **infrastructure** — filesystem, locking, transaction, Git, GitHub, and credential adapters.
- **cli** — Commander commands and Ink/plain/JSON renderers.
- **bootstrap** — the composition root where concrete adapters are wired.

The domain never imports Node APIs, Octokit, Ink, React, Commander, Execa, Zod, credential, or terminal libraries. Infrastructure errors are mapped to recovery-oriented `KestrelError` values before presentation.

The Mission aggregate controls its own lifecycle (`ACCEPTED → PREPARING → IN_PROGRESS → COMPLETED`, with `ABANDONED` terminal). Submission verification (`NONE → SUBMITTED → MERGED`) is modeled independently of the work lifecycle, and issue linkage is evidence rather than a required state.
