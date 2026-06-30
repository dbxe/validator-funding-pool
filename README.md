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
- both BLS deposit signatures verify for the deposit message and fork version;
- network metadata matches the intended chain;
- beacon state shows the committed pubkey with the pool withdrawal credentials.

These values are not private. Deposit data is designed to be publishable and becomes public when submitted to the deposit contract. The operator must not share validator private keys, mnemonics, keystore passwords, remote signer credentials, or validator-client secrets.

Repository scripts verify deposit roots and BLS signatures. `fund.ts` compares the local deposit-data file to the on-chain commitment before sending ETH. `fund.ts` and `top-up.ts` require `BEACON_NODE_URL` to confirm pool withdrawal credentials unless `UNSAFE_SKIP_BEACON_CONFIRMATION=1` is explicitly set for a local/devnet bypass.

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

The contract only enforces custody and pro-rata distribution of ETH that reaches the pool. Consensus withdrawals and exited principal reach the pool because withdrawal credentials point to the pool. EL priority fees and MEV are operator-controlled. The default expectation is that the operator keeps those as hardware incentive; if the group wants to split them, the operator can configure the fee recipient / builder payout address to the pool.

## Trust And Incentives

The operator bears the first loss of coordination failure. Before participants can fund, the operator must commit validator data and send the protocol-minimum `1 ETH` predeposit. That ETH is not refundable from this contract. If the group never completes the `31 ETH` top-up, the operator's predeposit remains at risk unless the validator is later fully funded, activated, and exited.

That upfront cost is what locks in the cross-layer safety property participants care about. Participants wait for beacon state to show the committed pubkey with the pool's `0x01` withdrawal credentials before funding. Ethereum consensus stores the withdrawal credentials when a validator is created, and later deposits for the same pubkey increase the validator balance rather than replacing those credentials. The relevant spec points are the [`0x01` withdrawal credential shape](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/phase0/validator.md#eth1_address_withdrawal_prefix), validator creation [storing `withdrawal_credentials`](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#modified-get_validator_from_deposit), and existing-pubkey deposit handling that only [increases balance](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#new-apply_pending_deposit).

Participants have no capital at risk until they fund after that verification. Once they fund, they are incentivized to complete the attempt promptly so dormant ETH starts earning consensus rewards. If an attempt expires before top-up, active funding becomes refundable and the operator can reopen funding with a different participant set.

Poor validator operation is still an operator trust boundary. The intended incentive alignment is that the operator has meaningful economic weight in the pool, including the `1 ETH` predeposit, so downtime, slashing, or deliberate misoperation harms the operator's own claim as well as everyone else's. This reduces but does not remove operator trust.

The unilateral escape hatch is EIP-7002. The operator can request exits before or after top-up because the operator bears the predeposit exposure. After top-up, final credited participants can request a full exit without operator permission. Current funding-attempt participants recover through the funding deadline and `refundTo()` if top-up does not happen; refund-only holders cannot request exits for a later validator they did not fund. Consensus processing still enforces validator-state preconditions, so execution-layer accepted requests can be ignored until those conditions are met; the contract therefore records attempts and allows retries. See the consensus [`process_withdrawal_request`](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#new-process_withdrawal_request) flow.

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
- `AccountingSnapshot(...)` is emitted after selected accounting actions and records the post-action observed state.
- Snapshots are emitted after predeposit, funding-attempt open/close, successful funding, top-up, callable topped-up ETH receipt, claims, and refunds.
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

### EIP-7002 Exit Attempts

EIP-7002 requests accepted by the execution-layer predeploy can still be ignored by consensus-layer processing. The contract records attempts and allows retries. Request fees are paid by the caller, not from pool proceeds.

### System Contract Addresses

The contract and scripts check that configured system addresses have code. Deployment records include observed code hashes. Code presence and recorded hashes help auditability, but operators must still verify the target chain and canonical system addresses.

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

## Defaults

- Ethereum deposit contract: `0x00000000219ab540356cBB839Cbe05303d7705Fa`
- EIP-7002 withdrawal request predeploy: `0x00000961Ef480Eb55e80D19ad83579A64c007002`
- Deposit data file: `deposit-data.json`
- Deployment record: `deployments/latest.json`

Override any address or path with environment variables when using a test chain. The contract checks that configured system addresses have code, but it does not hardcode mainnet-only addresses.

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
- `DEPOSIT_NETWORK_NAME`: optional deposit-file metadata check.
- `DEPOSIT_FORK_VERSION`: optional expected fork-version check. The deposit data itself must include `fork_version` unless this env var supplies it.
- `RECIPIENT`: optional nonzero, non-pool recipient for `claim` and `refund`.
- `BEACON_NODE_URL`: beacon REST URL for validator predeposit confirmation and exit preflight; required by `fund` and `top-up` unless explicitly bypassed.
- `UNSAFE_SKIP_BEACON_CONFIRMATION`: set to `1` only to bypass required `fund`/`top-up` beacon confirmation in local/devnet flows.

## License

MIT
