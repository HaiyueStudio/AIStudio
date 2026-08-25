# M12 prompt, context, cache and memory

G04 replaces the monolithic game-authoring prompt with a versioned, genre-neutral profile. The stable prefix has policy, structured-tool and general workflow modules; bounded playbooks are retrieved only when the current request needs interaction, motion, visual-feedback or repair guidance. Production modules contain no genre-specific entity or code examples and no evaluation oracle data.

Each model turn references immutable Operation Log CAS artifacts. The context bundle contains policy, capability manifest, project/no-project manifest, compact visible task summary, optional playbooks and either a current project baseline or a document delta. Artifacts are redacted before hashing and persistence, referenced only after durable storage, and re-read by the runtime before provider execution.

Provider sessions are reused only while their owning backend process is live. A same-revision follow-up transmits a digest reference instead of the full project body. A revision change uses nested object and stable-id array deltas. After restart, the durable conversation index restores the visible summary and sends a full current baseline to the new provider session; it never pretends an old ephemeral provider thread survived.

Task summaries contain only visible goals, approved decisions, normalized tool facts, acceptance statements and blockers. They are bounded, compacted and content-addressed; hidden chain-of-thought has no input field or persistence path.

`UsageRecordV2.contextCache` distinguishes local CAS hits/misses, delta-reused bytes, provider-cache-eligible bytes and provider-reported hit tokens. Eligibility never becomes a hit: when a backend omits cache-read evidence, the reported value remains `null` and the UI says `unknown`.
