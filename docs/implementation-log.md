# Implementation Log

## 2026-05-30

- Moved the suite into its standalone repository path and renamed the core contract to `ValidatorFundingPool`.
- Removed network-specific helper scripts and defaults. Runtime scripts now use generic `RPC_URL` / `PRIVATE_KEY` configuration.

## 2026-05-31

- Added accounting coverage for delayed claim timing, cumulative entitlement invariants, integer-division dust, forced ETH before staking, forced ETH after cancellation, and claim rollback when a participant cannot receive ETH.
- Added test-only mocks for forced ETH and rejecting ETH recipients. Production contract behavior was not changed.
- Added `sweepCanceledSurplus()` so forced ETH in a canceled pool does not remain stuck. Surplus weights are funded amounts at cancellation, falling back to funding targets if nobody funded.
- Simplified the contract to exactly one validator. Removed `validatorCount`, array-based staking, multi-validator storage, and multi-validator script paths.
- Restricted `stake()` to participants. This prevents a non-participant from choosing the validator key after the pool is fully funded.
- Added `claimTo`, `refundTo`, and `sweepCanceledSurplusTo` with zero-address rejection. The existing no-argument methods now default to sending to the participant address.

## 2026-06-03

- Changed deployment to start in `Uninitialized`. The pool accepts no normal ETH until the operator commits validator data.
- Added operator-only `commitValidator(pubkey, signature, depositDataRoot)`. Funding deadline now starts at commitment time, giving participants an inspection point before funding.
- Changed `stake()` to operator-only with no deposit-data arguments. It uses the committed validator data and always deposits exactly `32 ETH`.
- Enforced `32 ETH` funding target and rejected no-code deposit / withdrawal-request system addresses in the constructor.
- Replaced the one-shot exit latch with retryable exit-attempt accounting. EIP-7002 requests are attempts because accepted EL requests can still be ignored by CL-side processing.
- Rejected `address(0)` and `address(this)` for user-selected payout recipients.
- Added `commit-validator` script and deployment chain checks across runtime scripts. The commit script validates amount, withdrawal credentials, hex sizes, optional metadata, and recomputes the deposit data root.

## Design Decisions

- Chose the hybrid `0x01` model with one post-stake accounting rule: every ETH held by the pool after staking is distributed pro rata by participant funding weight.
- Removed contract-level operator premium. Operator compensation is intentionally outside Solidity through EL fee recipient / MEV recipient configuration. The default expectation is that the operator keeps EL priority fees / MEV as hardware incentive unless they configure those payouts to the pool.
- Kept a hard boundary between funding and live accounting. Claims are disabled until every configured validator deposit has been submitted by the pool.
- The pool computes `0x01` withdrawal credentials internally from `address(this)`. Operator-supplied deposit data must match those credentials or the official deposit contract will reject the deposit root.
- EIP-7002 support is full-exit only. Nonzero requested partial withdrawals are intentionally unsupported.
- No arbitrary call, delegatecall, upgrade hook, owner rescue, or consolidation-request path is included. This is how the pool prevents itself from authorizing a `0x01 -> 0x02` switch.
- Lifecycle testing covered funding, staking, live partial withdrawals, pro-rata claims, EIP-7002 full exit, final withdrawal, and final pro-rata claims.
