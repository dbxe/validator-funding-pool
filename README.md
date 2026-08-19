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

Beacon confirmation is mandatory in the supported repository scripts on every path that puts capital at risk: `commit-predeposit`, `fund`, and `top-up`. These paths require `BEACON_NODE_URL`, and no environment variable waives any part of it. `fund` and `top-up` run the identical preflight. Credentials are confirmed at a settled state and re-confirmed at head; head state must also show a fresh predeposit: no slashing, activation, activation-eligibility, exit, and withdrawable epochs all equal to `FAR_FUTURE_EPOCH`, and a balance of at least the 1,000,000,000 Gwei predeposit. These checks use the consensus fields rather than the Beacon API status label.

A head balance *above* 1 ETH is the one condition an operator resolves rather than a hard failure, and only once every other assertion has passed. The script prints why the excess is harmless and then requires an interactive typed confirmation: the operator types the exact observed balance in Gwei on a terminal. No environment variable, flag, or acknowledgement string substitutes for it, and a non-interactive stdin fails instead of proceeding. The confirmation waives nothing — credentials at both states, the slashing flag, all four epochs, and the 1 ETH balance floor stay fatal on both legs — and the confirmed run's final log line names the confirmed excess balance instead of reporting a plain pass. See [Hard Failure On Excess Predeposit Balance](#hard-failure-on-excess-predeposit-balance).

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

### Environment-Variable Anomaly Override

The top-up preflight used to accept a two-variable override that waived every mutable head-state assertion: balance, slashing, and all four epochs. It was removed rather than narrowed. An operator reaching for it is, by construction, about to send 31 ETH to a validator whose consensus state says something is wrong, and the preflight cannot tell a validator that was externally funded apart from one that was compromised. A waiver that broad is not an escape hatch, it is a way to lose the check exactly when it matters. The one condition that genuinely needed a way forward is handled below, and handled as a confirmation rather than a waiver.

### Hard Failure On Excess Predeposit Balance

Requiring the head balance to equal exactly 1 ETH turned a permissionless deposit into a brick. Anyone can deposit to the committed pubkey, and the deposit contract's 1 ETH minimum is the entire griefing cost. Before this change, one such deposit during the funding window raised the balance above 1,000,000,000 Gwei and hard-failed every subsequent `fund` and `top-up` preflight, with no supported way to finish the attempt and the operator's predeposit stranded.

Excess balance is harmless to custody. Withdrawal credentials are written once, when the validator is created, and a deposit for an existing pubkey only increases balance; every withdrawal, partial or full, pays the execution address in those credentials, which is the pool. What extra deposits change is activation timing and economics, not ownership — an uncredited external top-up that the pool distributes pro rata to its own participants, never back to the depositor.

So the resolution is an operator confirmation covering exactly the condition verified harmless, with everything else still fatal. A new environment variable was rejected for the same reason the old override was deleted: it converts a human judgement about one specific validator into a value that lives in a shell profile and applies to every run. Typing the observed balance on a terminal cannot be set once and forgotten.

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

## Plain-Transfer Funding

A participant can fund by sending a plain ETH transfer to the pool instead of calling `fund()`. `receive()` routes a transfer to the same `_fund(msg.sender, msg.value)` used by `fund()`, so during `Funding` the two paths are indistinguishable: same credit, same `ParticipantFunded` event, same `AccountingSnapshot`, same reverts. Exceeding the caller's remaining allocation reverts `FundingCapExceeded` on both paths; a plain transfer cannot silently over-fund. A non-participant reverts `NotParticipant` on both paths. Before `Funding`, and after an expired attempt is closed, both paths revert `InvalidState`.

The transfer path exists because it clear-signs. A zero-calldata transfer renders the destination and the amount on a hardware wallet; `fund()` calldata does not. `fund.ts` uses it by default on the `ledger` network.

### The One Divergence

The paths differ in exactly one state. Once the pool is `ToppedUp`, `fund()` reverts `InvalidState` and returns the ETH, while `receive()` accepts it as pool proceeds and emits `EthReceivedViaCall`. Accepted proceeds are shared pro rata by final credited weight, so a participant who lands a transfer in that window recovers only their own share of it. At a `12 ETH` weight, a stray `1 ETH` transfer returns `0.375 ETH` through `claim()` and donates the other `0.625 ETH` to the remaining participants.

That window is narrow, and reaching it requires the participant to have sent twice. `topUpValidator()` requires `totalActiveFundedWei` to equal exactly `31 ETH`, which requires every participant's remaining allocation to be zero — including the sender's. `fund.ts` refuses to send when the caller's remaining allocation is zero, and re-reads state, deadline, and remaining allocation together immediately before signing. So the sender's remaining allocation must go from nonzero at that re-read to zero before the transfer is mined, and only another transaction from that same sender can consume it.

The reachable sequence is therefore: the participant has two funding transactions in flight, the first fills their allocation, the operator's `topUpValidator()` lands, and the second arrives against a topped-up pool. The reverse ordering is safe — a second send that arrives while `Funding` is still open reverts `FundingCapExceeded` and the ETH comes back.

One other path reaches the same window without a double-send, and it is far narrower. If a single transfer stays unmined past the funding deadline, someone closes the expired attempt, the operator opens a fresh attempt that the sender is not part of or is fully funded without them, and that attempt tops up — then the stale transfer lands in `ToppedUp`. The final re-read requires the deadline to still be in the future, so this needs a transaction to sit pending for the rest of the funding window plus an entire second attempt. Underpriced funding transactions are the way to get there, so price them to confirm.

Operationally:

- Never run a funding command twice. Check `npm run status` first.
- If a funding transaction is stuck, replace it at the same nonce. Never send a second transaction at a new nonce.
- The final re-read narrows the window; it cannot close it. No off-chain check can.
- If certainty matters more than clear signing, use the calldata path with `FUND_VIA_TRANSFER=0`. A late `fund()` reverts and the ETH stays with the sender. That is the trade: the transfer path buys a readable device screen at the cost of the revert acting as a safety net in this one window.

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

A direct deposit before top-up raises the head balance above the 1 ETH predeposit, which the `fund` and `top-up` preflights surface as an interactive typed confirmation rather than a failure. See [Hard Failure On Excess Predeposit Balance](#hard-failure-on-excess-predeposit-balance).

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
| Third party deposits to the committed pubkey before top-up | Credentials and custody are unaffected; `fund` and `top-up` require an interactive typed confirmation of the observed balance before proceeding. |
| Validator shows any other head-state anomaly | `fund` and `top-up` fail closed; no environment variable can waive it. |
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

## Signing And Key Custody

Ranked, for mainnet:

1. **Ledger.** The signing key never reaches this machine. Use the `:ledger` commands.
2. **Encrypted keystore.** The key lives on this machine but never in a shell history, an env file, or a process listing.
3. **`PRIVATE_KEY` in the environment.** Development and test networks only. It is plaintext in your shell, your `.env`, and every child process.

### Ledger

Install the Ethereum app on the device, unlock it, and open the app before running a command. Then set `LEDGER_ADDRESS` to the account address the device will sign with, and run the `:ledger` variant of any action:

```bash
RPC_URL=https://... \
BEACON_NODE_URL=https://... \
LEDGER_ADDRESS=0xYourLedgerAccount \
npm run fund:ledger
```

Every write action has one: `deploy:ledger`, `deploy-forwarder:ledger`, `commit-predeposit:ledger`, `open-funding-attempt:ledger`, `close-expired-funding-attempt:ledger`, `fund:ledger`, `refund:ledger`, `top-up:ledger`, `claim:ledger`, `request-exit:ledger`, `sweep:ledger`. `status` reads only and needs no signer.

There are separate entries rather than one command with a network flag because Hardhat rejects a repeated `--network` option, so `npm run fund -- --network ledger` cannot work while `npm run fund` pins `--network rpc`. An environment-selected network is worse: the pinned `--network rpc` silently wins over `HARDHAT_NETWORK`, so a Ledger user who set the variable would sign with the plaintext key instead. Two explicit entries cannot be confused for each other.

The plugin locates `LEDGER_ADDRESS` by walking `m/44'/60'/<index>'/0/0` for indices `0` through `20` and asking the device for each address, so the first command of a session is slow and the device must stay unlocked throughout. An account on a different derivation scheme, such as the legacy `m/44'/60'/0'/<index>`, is not found; set `ledgerOptions.derivationFunction` on the `ledger` network for that case.

The `ledger` network configures no `accounts`, so no private key is read for it. `LEDGER_ADDRESS` is a public address, not a secret, and is read from the environment rather than the keystore; the `ledger` network refuses to load without it.

`eth_accounts` on the `ledger` network returns the node's accounts followed by the Ledger account. Every script signs with the first. Point `RPC_URL` at a node that exposes no unlocked accounts — any public provider, or your own node with the `personal`/`accounts` namespace disabled — or the scripts will sign with a node account instead of the device.

### Encrypted Keystore

`hardhat-keystore` ships as a plugin dependency of `@nomicfoundation/hardhat-toolbox-viem`, so it is already available with no config change. The config resolves `RPC_URL` and `PRIVATE_KEY` through `configVariable()`, which reads the keystore before falling back to the environment.

```bash
npx hardhat keystore set RPC_URL
npx hardhat keystore set PRIVATE_KEY
npx hardhat keystore list
npx hardhat keystore path
npm run fund
```

Values are prompted for, encrypted with a password, and stored outside the repository (`npx hardhat keystore path` prints where). Nothing is written to `.env`.

Two behaviours to know:

- The keystore takes precedence over the environment. A stale keystore entry shadows the `RPC_URL` you exported in your shell, with no warning. Use `npx hardhat keystore get RPC_URL` when a run targets the wrong chain.
- The keystore is skipped entirely under CI, which falls back to environment variables.

A keystore protects a key at rest on a machine you already trust. It does not protect against a compromised machine: once you enter the password the plaintext key is in this process. Only a hardware wallet moves the key out of reach.

### What The Device Actually Shows

A Ledger clear-signs a zero-calldata ETH transfer: destination address, amount, network, and fees all render on screen. Any transaction carrying calldata has to be blind-signed unless a clear-signing descriptor for that contract is loaded — the device shows the destination, the ETH value, and the fees, but not the decoded arguments. Blind signing must be enabled in the Ethereum app's settings for those actions to be possible at all.

| Action | Command | Calldata | On device |
| --- | --- | --- | --- |
| Fund via transfer | `npm run fund:ledger` | none | Clear-signed: pool address and amount |
| Fund via calldata | `FUND_VIA_TRANSFER=0 npm run fund:ledger` | `fund()` | Blind-signed; value is shown |
| Claim to self | `npm run claim:ledger` | `claim()` | Blind-signed; value `0` |
| Claim redirected | `RECIPIENT=0x... npm run claim:ledger` | `claimTo(address)` | Blind-signed; value `0`; recipient not shown |
| Refund to self | `npm run refund:ledger` | `refund()` | Blind-signed; value `0` |
| Refund redirected | `RECIPIENT=0x... npm run refund:ledger` | `refundTo(address)` | Blind-signed; value `0`; recipient not shown |
| Request exit | `npm run request-exit:ledger` | `requestExit(uint256)` | Blind-signed; value is the fee |
| Commit predeposit | `npm run commit-predeposit:ledger` | `commitAndPredeposit(...)` | Blind-signed; value `1 ETH` |
| Open funding attempt | `npm run open-funding-attempt:ledger` | `openFundingAttempt(address[],uint256[])` | Blind-signed; value `0` |
| Top up | `npm run top-up:ledger` | `topUpValidator()` | Blind-signed; value `0` |
| Close expired attempt | `npm run close-expired-funding-attempt:ledger` | `closeExpiredFundingAttempt()` | Blind-signed; value `0` |
| Sweep forwarder | `npm run sweep:ledger` | `sweep()` | Blind-signed; value `0` |

Funding is the only action with a clear-signed path, and it is the action that moves the most ETH. Everything else is blind-signed today.

### The `claimTo` And `refundTo` Wart

`claimTo(address)` and `refundTo(address)` take the payout address as an ABI argument, not as the transaction destination. On a blind-signed transaction the device shows the destination as the pool and the value as `0`. The address that will actually receive every wei you are owed sits inside calldata the device does not render. A host that has been tampered with can substitute a recipient and the device gives you nothing to compare against. It is the same exposure as any blind-signed argument, but it is the one argument in this contract whose corruption redirects funds outright.

Mitigations, in order:

1. Prefer the no-argument variants. `claim()` and `refund()` both exist and always pay `msg.sender`, which is the device's own account. There is no unverifiable address to corrupt. `claim.ts` and `refund.ts` use them whenever `RECIPIENT` is unset or equals the signing account, so leaving `RECIPIENT` unset is the safe default.
2. Reach for `claimTo` / `refundTo` only when the signing account genuinely cannot receive ETH.
3. When you must redirect, derive the recipient independently on a second machine and compare it against the address the script prints before you approve on the device. This detects a tampered env file; it does not detect a tampered signing host.
4. An ERC-7730 descriptor (see below) lets wallets that support it render the recipient. It does not help the Hardhat Ledger path, which requests no descriptor resolution.

### ERC-7730 Clear-Signing Descriptor

`clear-signing/` holds an ERC-7730 descriptor for the pool's user-facing functions. Submitting it to Ledger's registry is what makes wallets that consult the registry render arguments — the `claimTo` recipient in particular — instead of a data hash.

It does not change what `npm run *:ledger` shows. `@nomicfoundation/hardhat-ledger` calls `ledgerService.resolveTransaction(tx, {}, {})` with an empty resolution config, so it requests no external-plugin, token, or NFT descriptor for any transaction. Hardhat calldata paths stay blind-signed regardless of what is published. The descriptor is for participants who sign the same calls through Ledger Live or another registry-aware wallet.

See `clear-signing/README.md` for the deployment binding and registry submission steps.

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

The `PRIVATE_KEY=0x...` shown above is the development form. On mainnet, drop it and use `npm run <action>:ledger` with `LEDGER_ADDRESS` set, or store `RPC_URL` and `PRIVATE_KEY` in the encrypted keystore. See "Signing And Key Custody".

Environment variables:

- `LEDGER_ADDRESS`: Ledger account address for the `ledger` network; required by every `:ledger` command.
- `FUND_VIA_TRANSFER`: `1` forces `fund` to send a zero-calldata transfer, `0` forces the `fund()` calldata path. Defaults to the transfer path on the `ledger` network and to calldata elsewhere.
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
- `BEACON_CONFIRMATION_STATE_ID`: beacon state id for withdrawal-credential confirmation; must be `finalized` (the default) or `justified`, and any other value is fatal. `head` is rejected because it would collapse the two-state confirmation into a single head read. Mutable fresh-predeposit and exit checks always use head state.
- `REFUND_PARTICIPANTS`: optional comma-separated addresses for `status` to display refund-only claimants that are no longer in the current funding attempt.

## License

MIT
