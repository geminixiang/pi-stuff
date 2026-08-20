# Claim Visibility P0 Evaluation

## Security contract

A restricted-group channel ID and its implicit ownership claim are restricted metadata.

- A member of the group may see the channel ID and holder in `TeamDigest.claims`.
- A member outside the group must not see the channel ID or holder in `TeamDigest.claims`.
- Generic explicit work claims remain team-visible for coordination compatibility.
- Operator audit/results may retain hashed or explicit control metadata under the existing host trust model; this change concerns member-visible digests and prompts.

## Required scenarios

1. A creates a restricted group whose channel ID contains a unique canary and B is a member.
2. A and B may observe that group claim.
3. Outsider C is woken after group creation and must not receive the canary or holder through `digest.claims` or formatted `HELD CLAIMS`.
4. A separate explicit claim such as `work:review` remains visible to C.
5. Releasing/finishing preserves existing claim lifecycle semantics.
6. Existing public/direct/restricted routing and all prior tests remain green.

## Acceptance

```sh
npm test --workspace @geminixiang/pi-agent-team
npm run check --workspace @geminixiang/pi-agent-team
```

No existing test may be deleted, skipped, or weakened.

## Non-goals

- Cross-process team restoration
- Group deduplication or aliases
- Member suspension/capability revocation
- Batch commit receipts
- Claim namespace redesign
