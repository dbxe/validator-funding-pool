# Validator Funding Pool

Minimal `0x01` withdrawal-credential funding pool for a fixed group of known participants pooling into one Ethereum validator.

The contract is a non-tokenized agreement between known funders. It mints no ERC-20, ERC-721, ERC-1155, vault share, receipt token, or transferable claim. Economic rights are internal accounting only.

## What This Is

- One fixed participant set.
- One validator.
- Exact `32 ETH` funding target.
- Fixed participant funding caps, also used as post-stake economic weights.
- Pool-owned `0x01` withdrawal credentials: `0x01 || 11 zero bytes || address(pool)`.
- Pro-rata distribution of ETH that reaches the pool after staking.
- Participant-triggered EIP-7002 full-exit request attempts.

## What This Is Not

- Not a liquid staking protocol.
- Not a public deposit pool.
- Not a transferable claim, vault, receipt, or share system.
- Not an on-chain validator governance system.
- Not an operator replacement mechanism.
- Not an admin-rescue contract.
- Not a way to make EL priority fees / MEV trustless.
- Not an on-chain BLS proof-of-possession or beacon-state verifier.

The pool intentionally exposes no arbitrary external-call, delegatecall, upgrade, owner rescue, consolidation-request, or `0x01 -> 0x02` credential-switch path.

## Lifecycle

1. Deploy the pool with participants, funding targets, operator, and system contract addresses.
2. Read the pool address and withdrawal credentials.
3. Generate one validator deposit-data entry with regular `0x01` withdrawal credentials pointing to the pool address.
4. The operator commits the validator pubkey, signature, and deposit data root on-chain.
5. Participants inspect the committed validator data and then fund up to their caps.
6. The operator stakes the committed validator after exact `32 ETH` funding and before the funding deadline.
7. After staking, any ETH balance in the pool is claimable pro rata by funding weight.
8. Any participant can request a full validator exit through EIP-7002. Requests are retryable attempts, not a one-shot latch.

The funding deadline starts at validator commitment time, not deployment time. If the pool is not staked before the deadline, participants can cancel and refund exact funded amounts.

## Trust Boundaries

The operator is trusted to:

- provide deposit data with a valid BLS proof-of-possession;
- avoid reusing a validator pubkey;
- call `stake()` after full funding;
- run the validator correctly and avoid slashable behavior;
- configure EL priority fee / MEV recipients as agreed off-chain.

The contract only enforces custody and pro-rata distribution of ETH that reaches the pool. Consensus withdrawals and exited principal reach the pool because withdrawal credentials point to the pool. EL priority fees and MEV are operator-controlled. The default expectation is that the operator keeps those as hardware incentive; if the group wants to split them, the operator can configure the fee recipient / builder payout address to the pool.

## Accounting Model

- Funding targets must sum exactly to `32 ETH`.
- A participant's funding cap is also their proceeds weight.
- Claims use cumulative entitlement: `grossPoolProceeds() = address(pool).balance + totalClaimedWei()`.
- Claim timing does not change anyone's cumulative entitlement.
- Integer division can leave tiny rounding dust. At a fixed final gross amount, dust is bounded below the participant count in wei. Later proceeds can make prior dust claimable.
- User-selected payout recipients for `claimTo`, `refundTo`, and `sweepCanceledSurplusTo` cannot be `address(0)` or the pool itself.

Every post-stake wei held by the pool is treated as pool proceeds. The contract intentionally does not distinguish principal from rewards because consensus exit timing and CL-side exits make that harder to reason about.

## Event Reconciliation

Events are reconciliation aids, not the source of entitlement accounting.

- `EthReceivedViaCall(sender, amount)` is emitted only when ETH reaches `receive()` while the pool is staked.
- `AccountingSnapshot(...)` is emitted after selected accounting actions and records the post-action observed state.
- Snapshots are emitted after validator commitment, successful funding, staking, callable staked ETH receipt, cancellation, claims, refunds, and canceled-surplus sweeps.
- Snapshot events include balance, funded totals, claimed totals, canceled-surplus claimed totals, `grossPoolProceeds()`, and `grossCanceledSurplus()`.
- Silent balance increases can occur between snapshots. Consensus withdrawals, priority-fee / coinbase balance increases, and forced ETH can increase the pool balance without executing contract code and without emitting a pool event.
- A later snapshot-bearing transaction reveals those silent balance changes through the observed balance and gross accounting values.

Authoritative entitlement accounting remains balance-based. Events are useful for operations, audit trails, and reconciliation, but they are not a complete proceeds ledger or source-of-funds classifier.

## Forced ETH

Ordinary ETH transfers are accepted only during `Funding` and `Staked`. Forced ETH can still arrive through `selfdestruct`.

- Forced ETH before staking becomes pool proceeds after staking.
- Forced ETH after cancellation is outside refund accounting but can be swept as canceled surplus.
- If anyone funded before cancellation, canceled-surplus weights are funded amounts at cancellation.
- If nobody funded before cancellation, canceled-surplus weights are deployment funding targets.

There is no sender rescue path for forced ETH.

## Consensus Caveats

- Consensus withdrawals to `0x01` credentials increase the pool balance without calling `receive()` or emitting `EthReceivedViaCall`.
- The deposit contract checks the deposit data root but does not verify BLS proof-of-possession. The script recomputes the deposit root and includes a Lodestar-cross-checked fixture test, but BLS validity remains an off-chain responsibility.
- Committed deposit data is public before `stake()`. A third party could copy it and submit their own 32 ETH deposit first, but the withdrawal credentials still point to the pool. This is operational griefing, not theft.
- Beacon preflight checks only observe current beacon state. They cannot detect a deposit submitted to the EL deposit contract but not yet processed by CL.
- EIP-7002 requests accepted by the execution-layer predeploy can still be ignored by consensus-layer processing. The contract records attempts and allows retries. Request fees are paid by the caller, not from pool proceeds.

## Failure Modes

| Scenario | Contract outcome |
| --- | --- |
| Bad validator data committed before funding | Participants should not fund. |
| Bad validator data funded anyway and `stake()` reverts | Participants recover after the funding deadline through cancel/refund. |
| Operator disappears before staking | Participants recover after the funding deadline through cancel/refund. |
| Operator disappears after staking | Any participant can request an EIP-7002 full exit; retries are allowed. |
| Validator exits from CL side without EIP-7002 | Returned ETH is pool proceeds and is split pro rata. |
| Participant cannot receive ETH directly | Participant can use `claimTo`, `refundTo`, or `sweepCanceledSurplusTo`. |
| ETH is forced into the pool | It follows the forced-ETH rules above; no sender rescue exists. |

## Defaults

- Ethereum deposit contract: `0x00000000219ab540356cBB839Cbe05303d7705Fa`
- EIP-7002 withdrawal request predeploy: `0x00000961Ef480Eb55e80D19ad83579A64c007002`
- Deposit data file: `deposit-data.json`
- Deployment record: `deployments/latest.json`

Override any address or path with environment variables when using a test chain. The contract checks that configured system addresses have code, but it does not hardcode mainnet-only addresses.

## Commands

```bash
npm install
npm run build
npm test
```

RPC scripts use `RPC_URL` and `PRIVATE_KEY`:

```bash
RPC_URL=http://localhost:8545 \
PRIVATE_KEY=0x... \
PARTICIPANTS=0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222 \
FUNDING_TARGETS_GWEI=16000000000,16000000000 \
npm run deploy
```

The deploy script prints the pool-owned withdrawal credentials. Generate one validator deposit data entry with those credentials, place it at `deposit-data.json` or set `DEPOSIT_DATA_FILE`, then commit the validator data before anyone funds:

```bash
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run commit-validator
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run fund
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run refund
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run stake
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run claim
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run sweep-canceled-surplus
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run request-exit
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run status
```

Useful environment variables:

- `DEPOSIT_CONTRACT`: deposit contract address.
- `WITHDRAWAL_REQUEST_PREDEPLOY`: EIP-7002 predeploy address.
- `OPERATOR`: operator address; defaults to the deployer.
- `FUNDING_WINDOW_SECONDS`: funding window from validator commitment; defaults to `86400`.
- `PARTICIPANTS`: comma-separated participant addresses; defaults to the deployer.
- `FUNDING_TARGETS_GWEI`: comma-separated funding caps matching `PARTICIPANTS`; must sum to `32000000000`.
- `EXPECTED_PUBKEY`: optional pubkey check for `commit-validator`.
- `DEPOSIT_NETWORK_NAME` / `DEPOSIT_FORK_VERSION`: optional deposit-file metadata checks.
- `RECIPIENT`: optional nonzero, non-pool recipient for `claim`, `refund`, and `sweep-canceled-surplus`.
- `BEACON_NODE_URL`: optional beacon REST URL for validator pubkey absence checks before commit/stake and validator status checks before request-exit.

## License

MIT
