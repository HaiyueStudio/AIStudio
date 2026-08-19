# Operation log instructions

- Own the append-only durable journal, artifact references, redaction, recovery, retention, and bounded queries.
- Never store credentials, hidden chain-of-thought, arbitrary project snapshots, or unbounded binary payloads.
- Operation Log records facts; it never owns or rewrites Document History.
