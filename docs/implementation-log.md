# Implementation Log

## 2026-05-30

- Moved the suite into its standalone repository path and renamed the core contract to `ValidatorFundingPool`.
- Removed network-specific helper scripts and defaults. Runtime scripts now use generic `RPC_URL` / `PRIVATE_KEY` configuration.

## 2026-05-31

- Added accounting coverage for delayed claim timing, cumulative entitlement invariants, integer-division dust, forced ETH before staking, forced ETH after cancellation, and claim rollback when a participant cannot receive ETH.
- Added test-only mocks for forced ETH and rejecting ETH recipients. Production contract behavior was not changed.
- Added `sweepCanceledSurplus()` so forced ETH in a canceled pool does not remain stuck. Surplus weights are funded amounts at cancellation, falling back to funding targets if nobody funded.
- Simplified the contract to exactly one validator. Removed `validatorCount`, array-based staking, multi-validator storage, and multi-validator script paths.

## Design Decisions

- Chose the hybrid `0x01` model with one post-stake accounting rule: every ETH held by the pool after staking is distributed pro rata by participant funding weight.
- Removed contract-level operator premium. Operator compensation is intentionally outside Solidity through EL fee recipient / MEV recipient configuration.
- Kept a hard boundary between funding and live accounting. Claims are disabled until every configured validator deposit has been submitted by the pool.
- The pool computes `0x01` withdrawal credentials internally from `address(this)`. Operator-supplied deposit data must match those credentials or the official deposit contract will reject the deposit root.
- EIP-7002 support is full-exit only. Nonzero requested partial withdrawals are intentionally unsupported.
- No arbitrary call, delegatecall, upgrade hook, owner rescue, or consolidation-request path is included. This is how the pool prevents itself from authorizing a `0x01 -> 0x02` switch.
- Lifecycle testing covered funding, staking, live partial withdrawals, pro-rata claims, EIP-7002 full exit, final withdrawal, and final pro-rata claims.
