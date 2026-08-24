# M12 G02 verification

G02 installs a versioned cross-genre evaluation suite and a backend-neutral runner. The test matrix contains 56 tasks across seven game genres, three evaluation modes, two additional request phrasings per case, and fourteen seeded defects.

## Results

- The oracle reference fixture passes all seven canonical cases.
- A deliberately blank GameDocumentV2 implementation fails all seven cases and every acceptance rule.
- All fourteen seeded defects fail exactly their declared stable acceptance IDs.
- Repeated runs produce the same canonical report digest: `sha256:e5663c1bad15de69a72079a664a5e3ded1be3433fa2084a769722aafbfe731d0`.
- Every run now carries stable task/budget status plus turn/tool usage and cost-record links required by G03.
- The production prompt/tool source scan found no hidden replay, acceptance, failure-seed, or oracle strings.
- Suite/schema source files in the milestone and the installed AIStudio copies are byte-identical.
- The reference evidence is synthetic behavior metadata. It contains no real provider output, game solution code, or screenshot bytes.

## Commands

```text
npm run m12:g02:check
npm run check
node milestones/milestones/m12-ai-native-game-studio-general-authoring/testsets/verify-game-agent-evaluation-v1.mjs
```
