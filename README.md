# Validator Funding Pool

Minimal `0x01` withdrawal-credential funding pool for known participants funding one Ethereum validator.

The contract is a non-tokenized agreement between known funders. It mints no ERC-20, ERC-721, ERC-1155, vault share, receipt token, or transferable claim. Economic rights are internal accounting only.

## What This Is

- One validator pubkey.
- Pool-owned `0x01` withdrawal credentials: `0x01 || 11 zero bytes || address(pool)`.
- Operator-funded `1 ETH` protocol-minimum predeposit.
- Participant-funded `31 ETH` top-up after off-chain beacon verification.
- Fixed allocation per funding attempt.
- Pro-rata distribution of ETH that reaches the pool after top-up.
- Retryable EIP-7002 full-exit request attempts by the operator or final credited participants.

## What This Is Not

- Not a liquid staking protocol.
- Not a public deposit pool.
- Not a transferable claim, vault, receipt, or share system.
- Not an on-chain validator governance system.
- Not an operator replacement mechanism.
- Not an admin-rescue contract.
- Not a way to make EL priority fees / MEV trustless.
- Not an on-chain BLS proof-of-possession, deposit-log, or beacon-state verifier.

The pool intentionally exposes no arbitrary external-call, delegatecall, upgrade, owner rescue, consolidation-request, or `0x01 -> 0x02` credential-switch path.

## Lifecycle

1. Deploy the pool with operator and system contract addresses.
2. Read the pool address and withdrawal credentials.
3. Generate two deposit-data entries for the same validator pubkey and pool withdrawal credentials:
   - `1000000000` Gwei predeposit;
   - `31000000000` Gwei top-up.
4. Operator calls `commitAndPredeposit()` with the deposit data and sends exactly `1 ETH`.
5. Participants wait for beacon state to show the validator pubkey exists with the pool's withdrawal credentials.
6. Operator opens a fixed funding attempt whose economic targets sum to `32 ETH` and include the operator with at least `1 ETH`.
7. Participants fund their current-attempt caps. The operator's cap is its target minus the credited `1 ETH` predeposit.
8. Operator calls `topUpValidator()` after exact `31 ETH` active funding and before the deadline.
9. After top-up, any ETH balance in the pool, excluding outstanding failed-attempt refunds, is claimable pro rata by final economic weight.

If a funding attempt expires before top-up, anyone can close it. Active contributions become passive refund claims. The operator may open a new funding attempt without waiting for those refunds to be withdrawn. Refund claims are never rolled into later attempts automatically.

## Participant Verification

Participants should not fund until beacon state confirms the predeposit locked the validator pubkey to the pool withdrawal credentials. Before funding, participants should verify:

- the on-chain committed pubkey, signatures, and roots match the deposit-data file;
- both deposit-data entries use the pool's `0x01` withdrawal credentials;
- one entry is exactly `1000000000` Gwei and the other is exactly `31000000000` Gwei;
- both deposit data roots recompute correctly;
- both BLS deposit signatures verify against the connected beacon chain's `genesis_fork_version`;
- network metadata matches the intended chain;
- beacon state shows the committed pubkey with the pool withdrawal credentials.

These values are not private. Deposit data is designed to be publishable and becomes public when submitted to the deposit contract. The operator must not share validator private keys, mnemonics, keystore passwords, remote signer credentials, or validator-client secrets.

Repository scripts read the authoritative `genesis_fork_version` from the connected beacon node, require both deposit-data entries to declare that value, and use it to verify deposit roots and BLS signatures. `fund.ts` performs this chain check before looking up the validator, compares the local deposit-data file to the on-chain commitment before sending ETH, prints the current funding attempt, allocation, and operator target percentage, and supports optional expected-value checks for participants who want an extra local guardrail. Scripts that use withdrawal credentials read them from the live pool and compare them to the deployment record before relying on either value.

Beacon confirmation is mandatory in the supported repository scripts on every path that puts capital at risk: `commit-predeposit`, `fund`, and `top-up`. These paths require `BEACON_NODE_URL` with no bypass. Before both participant funding and the operator top-up, credentials are confirmed at finalized state and re-confirmed at head; head state must also show exactly the fresh 1 ETH predeposit: a 1,000,000,000 Gwei balance, no slashing, and activation, activation-eligibility, exit, and withdrawable epochs all equal to `FAR_FUTURE_EPOCH`. These checks use the consensus fields rather than the Beacon API status label.

`top-up` alone has an emergency two-variable override for mutable head-state anomalies. Setting both `UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY=1` and `I_UNDERSTAND_TOPUP_VALIDATOR_ANOMALY=1` waives only the balance, slashing, activation-epoch, and exit-epoch assertions so a validator externally funded into an anomalous state cannot permanently trap pool funds. It cannot waive beacon availability or health, chain fork identity, or withdrawal-credential confirmation at finalized or head state. `fund` has no override.

The `request-exit` recovery path deliberately treats its beacon preflight as advisory: without `BEACON_NODE_URL`, it warns and proceeds so an unavailable beacon API cannot disable the escape hatch. With a beacon URL, `request-exit.ts` uses head state and beacon spec constants to check that the validator is active, unexited, unslashed, and old enough for consensus to honor an EIP-7002 full-exit request.

## Trust Boundaries

The operator is trusted to:

- generate fresh validator key material;
- provide valid predeposit and top-up deposit data;
- pay the `1 ETH` predeposit before participants fund;
- open funding attempts with the agreed participants and weights;
- call `topUpValidator()` after exact funding;
- run the validator correctly and avoid slashable behavior;
- configure EL priority fee / MEV recipients as agreed off-chain.

The predeposit flow mitigates the main first-deposit credential-capture risk by making participant funding conditional on beacon state showing the validator pubkey already bound to the pool. A malicious operator can still slash, abandon, or misoperate the validator after top-up. This contract is trust-minimized, not trustless.

The contract only enforces custody and pro-rata distribution of ETH that reaches the pool. Consensus withdrawals and exited principal reach the pool because withdrawal credentials point to the pool. EL priority fees and MEV follow the operator-controlled `fee_recipient`, never withdrawal credentials, and remain outside anything this contract can enforce. The default expectation is that the operator keeps those rewards as hardware incentive.

Do not configure the pool itself as `fee_recipient`. Its `receive()` is state-dependent and rejects ordinary transfers before funding or top-up, which is the wrong property for a set-and-forget validator-client destination. It is also a heavier recipient than a baseline ETH transfer. If the group explicitly decides to pool EL rewards, use the optional `FeeRecipientForwarder` sidecar described below.

### Optional EL Rewards Forwarder

`FeeRecipientForwarder` is a fixed-destination sidecar for groups that choose to distribute EL priority fees and MEV through the pool. Its `receive()` is empty and unconditional, so a builder payment transaction does not depend on pool lifecycle state and stays near baseline transfer gas. Its immutable `pool` is validated at construction by checking the full pool-owned withdrawal credentials. There is no owner, pause, upgrade, rescue, arbitrary call, or alternate recipient.

Deploy it against the pool recorded in the deployment file with `npm run deploy-forwarder`. The script verifies the pool deployment, deploys the sidecar, verifies the forwarder's immutable destination, and adds the optional `feeRecipientForwarder` address to the record. Existing deployment records without that field remain valid.

Only after the pool is topped up, configure the validator client's `fee_recipient` to the recorded forwarder address. Validator-client configuration syntax varies by client. Do not point `fee_recipient` at the forwarder before top-up: although the forwarder always accepts ETH, `sweep()` cannot deliver it while the pool rejects ordinary ETH, and there is no rescue path if the pool never reaches `ToppedUp`.

Anyone can run `npm run sweep`. It transfers the forwarder's entire balance to the immutable pool, where the ETH becomes pool proceeds distributed pro rata by final credited weight. A zero-balance sweep reverts, and a sweep rejected by the pool remains permissionlessly retryable. `status` verifies the configured forwarder and displays its pending balance.

Pooling EL rewards changes the group's economics and must be an explicit group decision. The sidecar makes pooling possible and verifiable when it is configured, but it does not make MEV trustless or enforce the configuration. The operator still controls `fee_recipient` and can change or unset it at any time. The operator is also responsible for confirming contract-recipient behavior with the actual relay and builder set.

## Trust And Incentives

The operator bears the first loss of coordination failure. Before participants can fund, the operator must commit validator data and send the protocol-minimum `1 ETH` predeposit. That ETH is not refundable from this contract. If the group never completes the `31 ETH` top-up, the operator's predeposit remains at risk unless the validator is later fully funded, activated, and exited.

That upfront cost is what locks in the cross-layer safety property participants care about. Participants wait for beacon state to show the committed pubkey with the pool's `0x01` withdrawal credentials before funding. Ethereum consensus stores the withdrawal credentials when a validator is created, and later deposits for the same pubkey increase the validator balance rather than replacing those credentials. The relevant spec points are the [`0x01` withdrawal credential shape](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/phase0/validator.md#eth1_address_withdrawal_prefix), validator creation [storing `withdrawal_credentials`](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#modified-get_validator_from_deposit), and existing-pubkey deposit handling that only [increases balance](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#new-apply_pending_deposit).

Participants have no capital at risk until they fund after that verification. Once they fund, they are incentivized to complete the attempt promptly so dormant ETH starts earning consensus rewards. Only the operator can submit the top-up, so funding windows should be intentionally short. If an attempt expires before top-up, active funding becomes refundable and the operator can reopen funding with a different participant set.

Poor validator operation is still an operator trust boundary. The intended incentive alignment depends on the configured operator target: the contract enforces only that the operator has at least the `1 ETH` predeposit credited as economic weight. Groups that rely on operator self-exposure should configure a larger operator target. Downtime, slashing, or deliberate misoperation then harms the operator's own claim as well as everyone else's. This reduces but does not remove operator trust.

The unilateral escape hatch is EIP-7002. The operator can request exits before or after top-up because the operator bears the predeposit exposure. After top-up, final credited participants can request a full exit without operator permission. Current funding-attempt participants recover through the funding deadline and `refundTo()` if top-up does not happen; refund-only holders cannot request exits for a later validator they did not fund. Consensus processing still enforces validator-state preconditions, so execution-layer accepted requests can be ignored until those conditions are met; the contract therefore records attempts and allows retries. See the consensus [`process_withdrawal_request`](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#new-process_withdrawal_request) flow.

This is not a complete validator exit gate. The validator active key can still sign a consensus-layer voluntary exit outside this contract, and anyone with a valid pre-signed voluntary exit can submit it. If withdrawal credentials are correct, exited funds still return to the pool, but timing and opportunity cost can bypass the pool's local EIP-7002 caller restrictions.

## Considered And Rejected

### On-Chain Minimum Operator Weight

The pool does not enforce an immutable minimum operator target beyond the credited 1 ETH predeposit. Final targets must total exactly 32 ETH, so a participant's own target is exactly that participant's economic share; `EXPECTED_MY_TARGET_GWEI` can pin it without relying on any other participant's identity or target. A larger operator target is an alignment choice, not a custody or arithmetic invariant.

An immutable operator-weight floor was rejected because funding composition is deliberately re-formable across attempts. If the group later re-forms around a participant contributing more capital, a stale floor could force a redeploy. A redeploy changes the withdrawal credentials, while the original 1 ETH predeposit remains permanently bound to the old pool. The extra constructor surface would also need correct lower and upper bounds to avoid making predeposit accounting unsound or deploying a pool that can never open a valid funding attempt. It would improve legibility but would not tighten a protocol boundary.

### Required Beacon Preflight For Exit

`request-exit` deliberately does not require beacon API availability. Its preflight warns and proceeds when `BEACON_NODE_URL` is absent because the downside is a potentially wasted EIP-7002 request fee, while refusing would let an unavailable beacon endpoint disable the participants' recovery path during an emergency. Capital-entry paths fail closed; the escape hatch preserves liveness.

## Accounting Model

- The operator's `1 ETH` predeposit is credited to the operator's final economic weight.
- Funding-attempt targets are final economic weights and must sum exactly to `32 ETH`.
- The operator target must be at least `1 ETH`; the operator may fund additional ETH above the predeposit.
- Active funding is only for the current attempt.
- Expired-attempt funding becomes `refundableWeiOf[participant]`.
- Refund claims are independent liabilities and are excluded from proceeds.
- Claims use cumulative entitlement: `grossPoolProceeds() = address(pool).balance + totalClaimedWei() - totalRefundableWei()`.
- Claim timing does not change anyone's cumulative entitlement.
- Integer division can leave tiny rounding dust. Later proceeds can make prior dust claimable.
- User-selected payout recipients for `claimTo` and `refundTo` cannot be `address(0)` or the pool itself.

After top-up, every non-refund wei held by the pool is treated as pool proceeds. The contract intentionally does not distinguish principal from rewards because consensus exit timing and CL-side exits make that harder to reason about.

## Balance Increases Without Calls

The pool uses balance-based accounting, so ETH that reaches the pool is accounted for even if no Solidity function executes. Silent balance increases can come from:

- consensus withdrawals to the pool's `0x01` withdrawal credentials;
- priority-fee / coinbase payments if the validator or builder configuration points to the pool;
- forced ETH transfers, including `selfdestruct`-based transfers.

Ordinary ETH transfers are accepted only during `Funding` and `ToppedUp`. Forced ETH can still arrive in any state.

Forced ETH before top-up becomes pool proceeds after top-up, except that outstanding refund claims remain excluded. There is no sender rescue path for forced ETH.

## Event Reconciliation

Events are reconciliation aids, not the source of entitlement accounting.

- `EthReceivedViaCall(sender, amount)` is emitted only when ETH reaches `receive()` after top-up.
- `RefundCredited(attempt, participant, amount, participantTotal, totalRefundableWei)` is emitted when an expired attempt turns active funding into a passive refund claim.
- `AccountingSnapshot(...)` is emitted after selected accounting actions and records the post-action observed state.
- Snapshots are emitted after predeposit, funding-attempt open/close, successful funding, top-up, claims, and refunds, where the contract's accounting state changes.
- Snapshot events include funding attempt, balance, active funding, refund liabilities, refunded totals, final credited weights, claimed totals, and `grossPoolProceeds()`.
- Silent balance increases can occur between snapshots and may not emit any pool event.

Authoritative entitlement accounting remains balance-based. Events are useful for operations, audit trails, and reconciliation, but they are not a complete proceeds ledger or source-of-funds classifier.

## Cross-Layer Caveats

### Deposit Data And BLS

The deposit contract checks the deposit data root but does not verify BLS proof-of-possession. Repository scripts reject deposit data unless the root recomputes and the BLS deposit signature verifies for the deposit message and fork version.

Solidity does not verify BLS signatures. Bypassing the scripts and submitting invalid-but-well-formed deposit data can trap ETH in the deposit contract or fail to create the intended beacon validator.

### Pubkey Freshness

The contract cannot prove that a validator pubkey was globally unused before predeposit. Participants should rely on beacon confirmation before funding: if beacon state shows the committed pubkey with pool withdrawal credentials, later deposits for the same pubkey cannot switch credentials away from the pool.

This design intentionally avoids deposit-log scanning. A log scan can catch some pending EL deposits, but it is not a complete mempool-race solution. The practical safety boundary is that participants fund only after the predeposit is processed and visible in beacon state with pool credentials.

### Direct Validator Deposits

Only ETH sent through the pool is credited as participant funding. A third party can deposit directly to the same validator pubkey through the deposit contract after the pool credentials are locked. That does not change the validator withdrawal credentials, so it is not a theft path against pool participants, but it can affect validator activation timing, partial withdrawals, and reconciliation. Treat direct deposits as uncredited external top-ups or donations.

### EIP-7002 Exit Attempts

EIP-7002 requests accepted by the execution-layer predeploy can still be ignored by consensus-layer processing. The contract records attempts and allows retries. Request fees are paid by the caller, not from pool proceeds. `request-exit.ts` checks head beacon state before submitting, including the active status, `exit_epoch`, slashing flag, and `SHARD_COMMITTEE_PERIOD` age requirement, but the Solidity contract cannot enforce those consensus-state predicates.

### System Contract Addresses

Every operational script reads all five pool immutables and refuses if the deployment record disagrees on the deposit contract, withdrawal-request predeploy, operator, withdrawal credentials, or funding-window duration. Code hashes are then computed at the two system addresses read from the live pool and checked against the record.

On Ethereum mainnet, the scripts additionally pin both system-contract addresses and runtime code hashes to known canonical values from a source independent of the pool and record. This canonicity check catches a pool and record that agree with each other but were both configured with a false system contract. On an unrecognized test or development chain, the scripts keep enforcing record-to-pool consistency and print an explicit warning that canonicity is unverified.

### Future Protocol Operations

The contract is intentionally narrow. It supports pool-owned `0x01` withdrawal credentials and EIP-7002 full-exit request attempts. It does not expose arbitrary external calls for future staking operations, consolidation requests, credential changes, or `0x01 -> 0x02` migration paths.

Future Ethereum staking features may require contract changes or may simply be unsupported by this pool.

## Failure Modes

| Scenario | Contract outcome |
| --- | --- |
| Operator never predeposits | Participants cannot fund. |
| Predeposit never appears in beacon state with pool credentials | Participants should not fund. |
| Participant funds without beacon confirmation | The contract cannot prove the predeposit fixed pool credentials; this is an unsafe operational bypass. |
| Funding attempt expires before top-up | Anyone can close it; active funding becomes refundable. |
| Participant does not withdraw refund | Operator can still open a new attempt; old refund is excluded from proceeds. |
| Operator disappears before top-up | Participants recover active funding after deadline close/refund; operator predeposit remains at risk. |
| Operator disappears after top-up | Final credited participants can request EIP-7002 full-exit attempts; retries are allowed. |
| Validator exits from CL side without EIP-7002 | Returned ETH is pool proceeds, excluding outstanding refunds. |
| Participant cannot receive ETH directly | Participant can use `claimTo` or `refundTo`. |
| ETH is forced into the pool | It follows the forced-ETH rules above; no sender rescue exists. |
| Forwarder receives ETH before pool top-up | Funds remain in the forwarder until a permissionless sweep succeeds; they are stranded if the pool never tops up. |

## Defaults

- Ethereum deposit contract: `0x00000000219ab540356cBB839Cbe05303d7705Fa`
- EIP-7002 withdrawal request predeploy: `0x00000961Ef480Eb55e80D19ad83579A64c007002`
- Deposit data file: `deposit-data.json`
- Deployment record: `deployments/latest.json`

Override any address or path with environment variables when using an unrecognized test chain. The contract itself checks that configured system addresses have code but does not hardcode mainnet-only addresses; the operational scripts enforce the chain-specific mainnet pins and warn rather than applying them to unknown chain IDs.

## Commands

Install dependencies and run the local checks:

```bash
npm install
npm run build
npm test
```

Deploy:

```bash
RPC_URL=http://localhost:8545 \
PRIVATE_KEY=0x... \
npm run deploy
```

Generate predeposit and top-up deposit data with the printed pool withdrawal credentials, then commit the validator and submit the operator-funded predeposit:

```bash
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run commit-predeposit
```

After beacon confirmation, open a fixed funding attempt:

```bash
RPC_URL=http://localhost:8545 \
PRIVATE_KEY=0x... \
PARTICIPANTS=0xOperator,0xAlice,0xBob \
FUNDING_TARGETS_GWEI=20000000000,6000000000,6000000000 \
npm run open-funding-attempt
```

Participants fund, then the operator submits the top-up:

```bash
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run fund
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run top-up
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run status
```

Optionally deploy the EL-rewards sidecar after top-up, configure the validator client's `fee_recipient` to the printed forwarder address, and sweep accumulated rewards permissionlessly:

```bash
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run deploy-forwarder
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run sweep
```

Operational scripts:

```bash
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run close-expired-funding-attempt
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run refund
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run claim
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run request-exit
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run status
```

Environment variables:

- `DEPOSIT_CONTRACT`: deposit contract address.
- `WITHDRAWAL_REQUEST_PREDEPLOY`: EIP-7002 predeploy address.
- `OPERATOR`: operator address; defaults to the deployer.
- `FUNDING_WINDOW_SECONDS`: funding window per attempt; defaults to `86400`.
- `PARTICIPANTS`: comma-separated addresses for `open-funding-attempt`; must include the operator.
- `FUNDING_TARGETS_GWEI`: comma-separated final economic weights matching `PARTICIPANTS`; must sum to `32000000000`.
- `EXPECTED_PUBKEY`: optional pubkey check for `commit-predeposit`.
- `EXPECTED_FUNDING_ATTEMPT`: optional `fund` check for the active attempt number.
- `EXPECTED_MY_TARGET_GWEI`: optional `fund` check for the caller's current-attempt target.
- `EXPECTED_OPERATOR_TARGET_GWEI`: optional `fund` check for the operator's current-attempt target.
- `EXPECTED_DEADLINE_BEFORE`: optional `fund` check requiring the funding deadline to be at or before this Unix timestamp.
- `DEPOSIT_NETWORK_NAME`: optional deposit-file metadata check.
- `RECIPIENT`: optional nonzero, non-pool recipient for `claim` and `refund`.
- `BEACON_NODE_URL`: beacon REST URL for validator predeposit confirmation, funding and top-up preflights, and the advisory exit preflight; required by `commit-predeposit`, `fund`, and `top-up`.
- `BEACON_CONFIRMATION_STATE_ID`: optional beacon state id for withdrawal-credential confirmation; defaults to `finalized`. Mutable top-up and exit checks use head state.
- `UNSAFE_ALLOW_TOPUP_VALIDATOR_ANOMALY`: set to `1` only for an operator top-up that must waive mutable head-state balance, slashing, activation, or exit anomalies.
- `I_UNDERSTAND_TOPUP_VALIDATOR_ANOMALY`: must also be `1` to acknowledge the narrow top-up anomaly override; it never waives beacon availability, health, fork identity, or withdrawal-credential checks.
- `REFUND_PARTICIPANTS`: optional comma-separated addresses for `status` to display refund-only claimants that are no longer in the current funding attempt.

## License

MIT
