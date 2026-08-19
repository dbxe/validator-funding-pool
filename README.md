# Validator Funding Pool

Minimal `0x01` withdrawal-credential funding pool for known participants funding one Ethereum validator.

The contract is a non-tokenized agreement between known funders. It mints no ERC-20, ERC-721, ERC-1155, vault share, receipt token, or transferable claim. Economic rights are internal accounting only.

[`SECURITY.md`](SECURITY.md) is the security model: system and trust model, the table of enforced invariants and where each one is enforced, operational assumptions, and the residual-risk ledger. Read it before putting capital in.

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
- beacon state shows the committed pubkey with the pool withdrawal credentials;
- the pool's `withdrawalCredentials` are `0x01`, eleven zero bytes, then the pool's own address — anything else means the validator's consensus withdrawals do not pay this pool;
- the pool's deployed runtime bytecode is the bytecode this repository builds, and the source is verified on Sourcify.

The last two are the only checks that are not circular. Everything else compares an operator-supplied deployment record against the contract that record names, and those two can agree perfectly while describing a pool nobody audited. The scripts now perform both automatically: `assertDeploymentMatchesPool` derives the credentials from the pool's address rather than trusting `withdrawalCredentials()`, and uses the derived value everywhere a capital path needs credentials; `assertRuntimeCodeMatchesLocalBuild` reads the pool's runtime code from the chain and compares it against your own `npm run build` output, masking only the byte ranges the build artifact marks as immutables so that two deployments differing solely in their constructor arguments both pass and a single changed instruction does not. The check is fatal, with a `npm run build` instruction, when no artifact exists — in practice a rare branch, since `hardhat run` compiles the project before it runs a script. It reports which artifact and which of `hardhat.config.ts`'s two solidity profiles matched. The only artifact it will ever read is the one hardhat built in this checkout — no environment variable can add another candidate, because a candidate supplies both the bytecode the chain is compared against and the byte ranges the comparison ignores, and a candidate that supplies both can always be made to match. Hardhat keeps only the last-built profile's artifacts, and `hardhat run` recompiles with the default profile before it runs a script — so a separate `npx hardhat compile --build-profile production` is undone by the very next command. Verifying against the production profile means passing the profile to the command itself: `npm run fund -- --build-profile production`. That trailing global option is accepted after the pinned `--network`, verified by experiment on hardhat 3.12.0, and it leaves the artifact on the production profile afterwards; `SECURITY.md` §5 records the measurement. Both contracts this repository deploys are verified the same way; see "Optional EL Rewards Forwarder" for the sidecar. The declared immutable ranges are themselves checked for plausibility before anything is masked: they must be disjoint and must total no more than 2048 bytes. A real build of this contract declares 608 — solc emits a 32-byte range per immutable *reference site*, and the five immutables are read at 19 sites under both profiles.

Verifying the runtime code proves the pool runs the contract *this checkout* builds. It does not prove this checkout is the audited source: confirm the repository's provenance independently, and confirm the deployed source on Sourcify.

These values are not private. Deposit data is designed to be publishable and becomes public when submitted to the deposit contract. The operator must not share validator private keys, mnemonics, keystore passwords, remote signer credentials, or validator-client secrets.

Repository scripts read the authoritative `genesis_fork_version` from the connected beacon node, require both deposit-data entries to declare that value, and use it to verify deposit roots and BLS signatures. `fund.ts` performs this chain check before looking up the validator, compares the local deposit-data file to the on-chain commitment before sending ETH, prints the current funding attempt, allocation, and operator target percentage, and supports optional expected-value checks for participants who want an extra local guardrail. Those `EXPECTED_*` checks run twice: once against the review you read, and again in the final on-chain re-read immediately before signing, which also requires the funding attempt to be the same one the review described. After the transaction is mined, `fund` reads the receipt's own logs and requires the pool to have credited the signer with exactly the amount sent. Scripts that use withdrawal credentials read them from the live pool and compare them to the deployment record before relying on either value.

Beacon confirmation is mandatory in the supported repository scripts on every path that puts capital at risk: `commit-predeposit`, `fund`, and `top-up`. These paths require `BEACON_NODE_URL`, and no environment variable waives any part of it. `fund` and `top-up` run the identical preflight. Credentials are confirmed at a settled state and re-confirmed at head; head state must also show a fresh predeposit: no slashing, activation, activation-eligibility, exit, and withdrawable epochs all equal to `FAR_FUTURE_EPOCH`, and a balance of at least the 1,000,000,000 Gwei predeposit. These checks use the consensus fields rather than the Beacon API status label.

A head balance *above* 1 ETH is the one condition the person running the command resolves rather than a hard failure, and only once every other assertion has passed. The script prints why the excess is harmless and then requires an interactive typed confirmation: whoever runs `fund` or `top-up` types the exact observed balance in Gwei on a terminal. No environment variable, flag, or acknowledgement string substitutes for it, and a non-interactive stdin fails instead of proceeding. Once the balance is confirmed the entire head-state preflight is re-run against a fresh fetch — node health, credentials, slashing, all four epochs, balance — and the fresh balance must still equal the confirmed value exactly; a validator whose state moved while the prompt was open is fatal, not waived. The confirmation waives nothing — credentials at both states, the slashing flag, all four epochs, and the 1 ETH balance floor stay fatal on both legs — and the confirmed run's final log line names the confirmed excess balance instead of reporting a plain pass. See [Hard Failure On Excess Predeposit Balance](#hard-failure-on-excess-predeposit-balance).

Three things about how those beacon reads are made. The validator body must echo the pubkey that was asked about, so a proxy that answers every query with one particular validator's record cannot satisfy the credential, balance, slashing, and epoch checks with a body about a different validator. `commit-predeposit` establishes the committed pubkey's absence positively — HTTP 200 and an empty validator list — rather than reading a 404 as "not there", because a 404 is equally what a wrong path or an endpoint that is not a beacon node returns. And a path component in `BEACON_NODE_URL` is preserved, so a hosted endpoint of the form `https://host/eth-beacon-node/<key>` is queried under that prefix instead of at the host root.

`fund` and `top-up` re-run the entire head-state preflight once more immediately before signing, and require the balance to equal the value the full preflight settled on. That shrinks the window between "the state was checked" and "the transaction was sent" from minutes — the funding review, plus device approval time — to seconds. It cannot close it; the remaining stretch runs from signing to inclusion and is described in [`SECURITY.md`](SECURITY.md) §5.

The `request-exit` recovery path deliberately treats its beacon preflight as advisory: without `BEACON_NODE_URL`, it warns and proceeds so an unavailable beacon API cannot disable the escape hatch. With a beacon URL, `request-exit.ts` uses head state and beacon spec constants to check that the validator is active, unexited, unslashed, and old enough for consensus to honor an EIP-7002 full-exit request.

## Trust Boundaries

This section states the operator-facing boundaries. [`SECURITY.md`](SECURITY.md) covers every party — operator, participants, third parties, the two endpoints, and the script host — and maps each enforced invariant to the function that enforces it.

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

Deploy it against the pool recorded in the deployment file with `npm run deploy-forwarder`. The script verifies the pool deployment, deploys the sidecar, verifies the forwarder's immutable destination, verifies the deployed forwarder's runtime code against your own build of `contracts/FeeRecipientForwarder.sol`, and adds the optional `feeRecipientForwarder` address to the record. Existing deployment records without that field remain valid.

That last check is the one that matters most for a sidecar. `pool()` returning the right pool is what the deployed code *chooses* to report, so a contract that answers correctly and forwards the balance somewhere else would pass a binding check; the code comparison is what rules that out. The three commands whose work touches the forwarder run it — `sweep`, `deploy-forwarder`, and `status` — and it masks only the two 32-byte ranges the single `pool` immutable occupies. The other commands skip the forwarder entirely: they never read it, and a sidecar for optional rewards must not be able to stop `refund`, `claim`, or `request-exit`. Set `EXPECTED_FORWARDER` to pin the recorded address the way `EXPECTED_POOL` pins the pool; that pin *is* evaluated everywhere a record is read, because it costs a string comparison and depends on nothing.

Only after the pool is topped up, configure the validator client's `fee_recipient` to the recorded forwarder address. Validator-client configuration syntax varies by client. Do not point `fee_recipient` at the forwarder before top-up: although the forwarder always accepts ETH, `sweep()` cannot deliver it while the pool rejects ordinary ETH, and there is no rescue path if the pool never reaches `ToppedUp`.

Anyone can run `npm run sweep`. It transfers the forwarder's entire balance to the immutable pool, where the ETH becomes pool proceeds distributed pro rata by final credited weight. A zero-balance sweep reverts, and a sweep rejected by the pool remains permissionlessly retryable. `status` verifies the configured forwarder and displays its pending balance.

After the receipt, `sweep` proves the ETH landed: it requires the receipt's own `Swept` log to be there for this signer, and the pool's balance across the sweep's own block to have risen by at least what the forwarder was holding. That balance delta is reconciled against the pool's own logs for the same block first — a `claim()` or a `refund()` mined alongside the sweep is ordinary, and its payout comes off the same delta, so the pool's `Claimed`, `Refunded`, and top-up events are added back before the comparison and the pass says what was netted. A rise *above* what the forwarder held is reported rather than refused — the forwarder is a fee recipient, so a proposal can pay into it between the balance read and the sweep. A shortfall that survives the reconciliation is fatal and tells you to reconcile with `npm run status` before re-running. Like the funding credit check, this is detection and not prevention: the ETH has already left the forwarder by the time it runs.

Pooling EL rewards changes the group's economics and must be an explicit group decision. The sidecar makes pooling possible and verifiable when it is configured, but it does not make MEV trustless or enforce the configuration. The operator still controls `fee_recipient` and can change or unset it at any time. The operator is also responsible for confirming contract-recipient behavior with the actual relay and builder set.

## Trust And Incentives

The operator bears the first loss of coordination failure. Before participants can fund, the operator must commit validator data and send the protocol-minimum `1 ETH` predeposit. That ETH is not refundable from this contract. If the group never completes the `31 ETH` top-up, the operator's predeposit remains at risk unless the validator is later fully funded, activated, and exited.

That upfront cost is what locks in the cross-layer safety property participants care about. Participants wait for beacon state to show the committed pubkey with the pool's `0x01` withdrawal credentials before funding. Ethereum consensus stores the withdrawal credentials when a validator is created, and later deposits for the same pubkey increase the validator balance rather than replacing those credentials. The relevant spec points are the [`0x01` withdrawal credential shape](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/phase0/validator.md#eth1_address_withdrawal_prefix), validator creation [storing `withdrawal_credentials`](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#modified-get_validator_from_deposit), and existing-pubkey deposit handling that only [increases balance](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#new-apply_pending_deposit).

Participants have no capital at risk until they fund after that verification. Once they fund, they are incentivized to complete the attempt promptly so dormant ETH starts earning consensus rewards. Only the operator can submit the top-up, so funding windows should be intentionally short. If an attempt expires before top-up, active funding becomes refundable and the operator can reopen funding with a different participant set.

Poor validator operation is still an operator trust boundary. The intended incentive alignment depends on the configured operator target: the contract enforces only that the operator has at least the `1 ETH` predeposit credited as economic weight. Groups that rely on operator self-exposure should configure a larger operator target. Downtime, slashing, or deliberate misoperation then harms the operator's own claim as well as everyone else's. This reduces but does not remove operator trust.

As a general recommendation, an operator target of at least `16 ETH` — a majority of the `32 ETH` validator — makes the arithmetic unambiguous: every loss the pool takes to a penalty, a slashing, or missed rewards is shared pro rata by credited weight, so at half or more of the weight the operator bears at least half of any such loss and cannot come out ahead by operating the validator badly. Below that threshold the operator can be the party with the least to lose from their own misoperation. It is a coordination choice, not an enforced one: nothing in the contract requires it beyond the `1 ETH` floor, and it does not address deliberate abandonment, only makes it self-punishing.

The unilateral escape hatch is EIP-7002. The operator can request exits before or after top-up because the operator bears the predeposit exposure. After top-up, final credited participants can request a full exit without operator permission. Current funding-attempt participants recover through the funding deadline and `refundTo()` if top-up does not happen; refund-only holders cannot request exits for a later validator they did not fund. Consensus processing still enforces validator-state preconditions, so execution-layer accepted requests can be ignored until those conditions are met; the contract therefore records attempts and allows retries. See the consensus [`process_withdrawal_request`](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#new-process_withdrawal_request) flow.

This is not a complete validator exit gate. The validator active key can still sign a consensus-layer voluntary exit outside this contract, and anyone with a valid pre-signed voluntary exit can submit it. If withdrawal credentials are correct, exited funds still return to the pool, but timing and opportunity cost can bypass the pool's local EIP-7002 caller restrictions.

## Considered And Rejected

### On-Chain Minimum Operator Weight

The pool does not enforce an immutable minimum operator target beyond the credited 1 ETH predeposit. Final targets must total exactly 32 ETH, so a participant's own target is exactly that participant's economic share; `EXPECTED_MY_TARGET_GWEI` can pin it without relying on any other participant's identity or target. A larger operator target is an alignment choice, not a custody or arithmetic invariant.

An immutable operator-weight floor was rejected because funding composition is deliberately re-formable across attempts. If the group later re-forms around a participant contributing more capital, a stale floor could force a redeploy. A redeploy changes the withdrawal credentials, while the original 1 ETH predeposit remains permanently bound to the old pool. The extra constructor surface would also need correct lower and upper bounds to avoid making predeposit accounting unsound or deploying a pool that can never open a valid funding attempt. It would improve legibility but would not tighten a protocol boundary.

### Required Beacon Preflight For Exit

`request-exit` deliberately does not require beacon API availability. Its preflight warns and proceeds when `BEACON_NODE_URL` is absent because the downside is a potentially wasted EIP-7002 request fee, while refusing would let an unavailable beacon endpoint disable the participants' recovery path during an emergency. Capital-entry paths fail closed; the escape hatch preserves liveness.

The deposit-data file is treated the same way, and for the same reason. `committedPubkey()` comes from the EL RPC and it is the *subject* of the exit preflight, so `request-exit` compares it against the local file exactly as `top-up` does — but a file that is missing or malformed produces a warning and the RPC's value is used, rather than a refusal. A readable file naming a different validator is still fatal: that is not an unavailable dependency, it is two inputs describing different things.

### Environment-Variable Anomaly Override

The top-up preflight used to accept a two-variable override that waived every mutable head-state assertion: balance, slashing, and all four epochs. It was removed rather than narrowed. An operator reaching for it is, by construction, about to send 31 ETH to a validator whose consensus state says something is wrong, and the preflight cannot tell a validator that was externally funded apart from one that was compromised. A waiver that broad is not an escape hatch, it is a way to lose the check exactly when it matters. The one condition that genuinely needed a way forward is handled below, and handled as a confirmation rather than a waiver.

### Hard Failure On Excess Predeposit Balance

Requiring the head balance to equal exactly 1 ETH turned a permissionless deposit into a brick. Anyone can deposit to the committed pubkey, and the deposit contract's 1 ETH minimum is the entire griefing cost. Before this change, one such deposit during the funding window raised the balance above 1,000,000,000 Gwei and hard-failed every subsequent `fund` and `top-up` preflight.

There was a way forward for `top-up`, and it was the wrong one. The two-variable override described above waived every mutable head-state assertion at once — balance, slashing, and all four epochs — so an operator could push the top-up through by waiving far more than the one condition that was actually harmless. `fund` had no route at all: the override only ever applied to the top-up leg, so participants were simply stuck, and the operator's predeposit stayed stranded until the funding window expired.

Excess balance is harmless to custody. Withdrawal credentials are written once, when the validator is created, and a deposit for an existing pubkey only increases balance; every withdrawal, partial or full, pays the execution address in those credentials, which is the pool. What extra deposits change is activation timing and economics, not ownership — an uncredited external top-up that the pool distributes pro rata to its own participants, never back to the depositor.

So the resolution is an interactive confirmation covering exactly the condition verified harmless, with everything else still fatal. A new environment variable was rejected for the same reason the old override was deleted: it converts a human judgement about one specific validator into a value that lives in a shell profile and applies to every run. Typing the observed balance on a terminal cannot be set once and forgotten.

The confirmation is about a state that was read before the prompt appeared, and a person can sit at a prompt for minutes. So the confirmation is not the last word: `assertBeaconValidatorIsFreshPredeposit` in `scripts/lib/common.ts` re-runs the whole head-state preflight from a fresh fetch afterwards and additionally requires the fresh balance to equal the confirmed value exactly. Any difference aborts and tells the operator to re-run, rather than sending capital against a stale read.

The confirmation's guarantee is precise and worth stating precisely. Ordinary non-interactive execution — a pipe, a cron job, CI — is rejected, and there is no environment variable, flag, or acknowledgement string that stands in for a typed answer. It is not proof against the machine's owner: a deliberate PTY wrapper such as `expect` or `script(1)` can drive any interactive program, and nothing in a local script can prevent that. The check exists to stop accidents and ambient automation, which is the threat it is aimed at.

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

The paths differ in exactly one state. Once the pool is `ToppedUp`, `fund()` reverts `InvalidState` and returns the ETH, while `receive()` accepts it as pool proceeds and emits `EthReceivedViaCall`. Accepted proceeds are shared pro rata by *final credited weight*, and `receive()` in `ToppedUp` accepts ETH from anyone without checking who sent it.

How much comes back therefore depends on whether the sender is credited in the attempt that topped up:

- **Credited in that attempt.** They recover their own share. At a `12 ETH` weight, a stray `1 ETH` transfer returns `0.375 ETH` through `claim()` and donates the other `0.625 ETH` to the remaining participants.
- **Not credited in that attempt.** They recover nothing. `claimable()` returns `0` for any address whose `creditedWeiOf` is zero, and `claim()` has nothing to pay it. The whole transfer is donated. This is the case for a sender whose transfer sat unmined while their attempt expired and a fresh attempt without them topped up.

That window is narrow, and reaching it requires the participant to have sent twice. `topUpValidator()` requires `totalActiveFundedWei` to equal exactly `31 ETH`, which requires every participant's remaining allocation to be zero — including the sender's. `fund.ts` refuses to send when the caller's remaining allocation is zero, and re-reads state, deadline, and remaining allocation together immediately before signing. So the sender's remaining allocation must go from nonzero at that re-read to zero before the transfer is mined, and only another transaction from that same sender can consume it.

The reachable sequence is therefore: the participant has two funding transactions in flight, the first fills their allocation, the operator's `topUpValidator()` lands, and the second arrives against a topped-up pool. The reverse ordering is safe — a second send that arrives while `Funding` is still open reverts `FundingCapExceeded` and the ETH comes back.

One other path reaches the same window without a double-send, and it is far narrower — and it is the total-loss one. If a single transfer stays unmined past the funding deadline, someone closes the expired attempt, the operator opens a fresh attempt that the sender is not part of or is fully funded without them, and that attempt tops up — then the stale transfer lands in `ToppedUp` against a pool that credits the sender nothing. The final re-read requires the deadline to still be in the future, so this needs a transaction to sit pending for the rest of the funding window plus an entire second attempt. Underpriced funding transactions are the way to get there, so price them to confirm.

There is a third way in, and it needs neither a double-send nor a stuck transaction. Every state check `fund.ts` makes — including the final re-read — reads the endpoint in `RPC_URL`. An RPC that is stale, forked, or dishonest and reports `Funding` for a pool that is already `ToppedUp` lets a single, first-and-only transfer straight through into the proceeds window. Nothing local can *prevent* it: the script cannot detect a lie using the same endpoint that is telling it, and unlike `fund()` there is no revert underneath. **The plain-transfer path trusts the EL RPC's freshness.** That is the real cost of the clear-signed device screen, alongside the timing race above. Point `RPC_URL` at an endpoint you control or trust; where you cannot, `FUND_VIA_TRANSFER=0` puts the contract's revert back underneath you.

All three modes are *detected* after the fact. `fund.ts` reads the mined receipt's own logs and requires a `ParticipantFunded` event from the pool for the signing account with exactly the amount sent. A receipt that carries `EthReceivedViaCall` instead is fatal and says so: the ETH was accepted as post-top-up proceeds, not credited as funding. This is detection, not prevention — the transfer is already on chain — but the receipt is the one piece of evidence that is not another read from the endpoint that may have lied, so an uncredited transfer ends in a loud failure and an instruction to reconcile rather than in a success line.

Operationally:

- Never run a funding command twice. Check `npm run status` first.
- If a funding transaction is stuck, replace it at the same nonce. Never send a second transaction at a new nonce.
- The final re-read narrows the window; it cannot close it. No off-chain check can.
- If the receipt check fires, the ETH is already gone. Run `npm run status` and reconcile before sending anything else.
- The final re-read is only as fresh as `RPC_URL`. Use an endpoint you control or trust, over TLS: on plaintext `http://` to a non-loopback host, anyone on the network path has the same capability as a dishonest endpoint. Every command warns when either URL is plaintext.
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

### What A Failure Prints

Every command that fails exits `1` and prints a short block on stderr: a header naming the command, then the walked cause chain's messages with the decoded contract error — `FundingStillOpen()`, `FundingCapExceeded()` — on the line directly under the header. A check this repository makes itself prints its whole message, because the message is the instruction.

The complete error object, with the contract ABI, every stack frame, and the raw cause chain, is one variable away:

```bash
DEBUG=1 npm run fund
```

Reach for it when the summary is not enough. Nothing is filtered out of the summary that changes what happened — only how much of it you have to read to see it.

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

Every write action has one: `deploy:ledger`, `deploy-forwarder:ledger`, `commit-predeposit:ledger`, `open-funding-attempt:ledger`, `close-expired-funding-attempt:ledger`, `fund:ledger`, `refund:ledger`, `top-up:ledger`, `claim:ledger`, `request-exit:ledger`, `sweep:ledger`.

`status` reads only, so it has no `:ledger` variant and needs no signer. It runs on its own `read` network, which sets no `accounts` at all. That is load-bearing rather than tidy: the `rpc` network declares `accounts: [configVariable("PRIVATE_KEY")]`, and Hardhat resolves an http network's `accounts` array on the connection's first JSON-RPC request, so on `rpc` even a pure `eth_call` fails when no `PRIVATE_KEY` is resolvable. A Ledger-only operator has no private key anywhere, and `npm run status` has to keep working for them.

There are separate entries rather than one command with a network flag because Hardhat rejects a repeated `--network` option, so `npm run fund -- --network ledger` cannot work while `npm run fund` pins `--network rpc`. An environment-selected network is worse: the pinned `--network rpc` silently wins over `HARDHAT_NETWORK`, so a Ledger user who set the variable would sign with the plaintext key instead. Two explicit entries cannot be confused for each other.

The plugin locates `LEDGER_ADDRESS` by walking `m/44'/60'/<index>'/0/0` for indices `0` through `20` and asking the device for each address. That walk happens **only for an address the plugin has not seen before**. On success it writes the address-to-path mapping to a cache file and, on every later run, returns the cached path for that address without asking the device to derive anything (`@nomicfoundation/hardhat-ledger/dist/src/internal/handler.js`, `#derivePath`, lines 190-192). So the first command against a new address is slow, later ones are not, and the device must stay unlocked throughout either way. An account on a different derivation scheme, such as the legacy `m/44'/60'/0'/<index>`, is not found; set `ledgerOptions.derivationFunction` on the `ledger` network for that case.

The cache is a persistent file outside this repository, at `<hardhat config dir>/ledger/accounts.json` (`internal/cache.js`); the config directory is `env-paths("hardhat").config`, which is `~/Library/Preferences/hardhat-nodejs` on macOS, `${XDG_CONFIG_HOME:-~/.config}/hardhat-nodejs` on Linux, and `%APPDATA%\hardhat-nodejs\Config` on Windows.

**Delete that file whenever the connected device or the seed on it changes.** A cached path is trusted, not re-verified: if a different device or a restored-from-different-seed device is plugged in, the plugin asks it to sign at the cached path, that path holds a different key on the new seed, and nothing in the plugin notices. The transaction is signed by an account you did not intend. Every transacting script therefore checks the mined `receipt.from` against the address it signed for and fails loudly on a mismatch (`waitForSenderVerifiedReceipt` in `scripts/lib/common.ts`) — but that is after-the-fact detection of a transaction already on chain, not prevention. Clearing the cache is the prevention.

The `ledger` network configures no `accounts`, so no private key is read for it. `LEDGER_ADDRESS` is a public address, not a secret, and is read from the environment rather than the keystore; the `ledger` network refuses to load without it.

`eth_accounts` on the `ledger` network returns the node's accounts followed by the Ledger account (`@nomicfoundation/hardhat-ledger/dist/src/internal/hook-handlers/network.js`, lines 47-63). Every script signs with the first. Point `RPC_URL` at a node that exposes no unlocked accounts — any public provider, or your own node with the `personal`/`accounts` namespace disabled. Every transacting script also asserts before signing that the account it is about to use equals `LEDGER_ADDRESS` whenever the connection routes signing through a device, and prints the active signer address on every network (`assertActiveSigner` in `scripts/lib/common.ts`), so a node account slipping into first place aborts the run instead of silently signing.

### Encrypted Keystore

`hardhat-keystore` ships as a plugin dependency of `@nomicfoundation/hardhat-toolbox-viem`, so it is already available with no config change. The config resolves `RPC_URL` and `PRIVATE_KEY` through `configVariable()`, which consults the keystore only when the environment does not already supply the value.

```bash
npx hardhat keystore set RPC_URL
npx hardhat keystore set PRIVATE_KEY
npx hardhat keystore list
npx hardhat keystore path
npm run fund
```

Values are prompted for, encrypted with a password, and stored outside the repository (`npx hardhat keystore path` prints where). Nothing is written to `.env`.

Two behaviours to know:

- **The environment outranks the keystore, not the other way around.** Hardhat reads `process.env[name]` first and, when it finds a string there, returns it and skips the `configurationVariables` hook chain entirely — so the keystore plugin is never consulted (`hardhat/dist/src/internal/core/configuration-variables.js`, `_getRawValue`, lines 77-84). An empty string counts as set, so even `export PRIVATE_KEY=` wins. A forgotten `export PRIVATE_KEY=...` or a sourced `.env` therefore silently outranks the key you stored, and the run signs with the plaintext key while you believe the keystore is in use.

  Before any mainnet command, clear both in the shell that will run it and confirm the keystore still holds what you expect:

  ```bash
  unset PRIVATE_KEY RPC_URL
  npx hardhat keystore get RPC_URL
  npx hardhat keystore get PRIVATE_KEY
  ```

  `keystore get` reads the keystore directly and is unaffected by the environment, so it tells you what the keystore holds, not what a run would use. The `unset` is what makes the run use it.
- The keystore is skipped entirely under CI, which falls back to environment variables (`@nomicfoundation/hardhat-keystore/dist/src/internal/hook-handlers/configuration-variables.js`, lines 17-19).

A keystore protects a key at rest on a machine you already trust. It does not protect against a compromised machine: once you enter the password the plaintext key is in this process. Only a hardware wallet moves the key out of reach.

### What The Device Actually Shows

A Ledger clear-signs a zero-calldata ETH transfer: destination address, amount, network, and fees all render on screen. A *call* to an existing contract has a destination, so the device shows that address, the ETH value, and the fees — but not the decoded arguments, unless a clear-signing descriptor for that contract is loaded. A *contract creation* has no destination at all: the device shows creation bytecode with the constructor arguments appended, and there is no address to compare against anything. Blind signing must be enabled in the Ethereum app's settings for any of these to be possible at all.

| Action | Command | Calldata | On device |
| --- | --- | --- | --- |
| Fund via transfer | `npm run fund:ledger` | none | Clear-signed: pool address and amount |
| Fund via calldata | `FUND_VIA_TRANSFER=0 npm run fund:ledger` | `fund()` | Blind-signed; destination and value shown |
| Claim to self | `npm run claim:ledger` | `claim()` | Blind-signed; destination shown; value `0` |
| Claim redirected | `RECIPIENT=0x... npm run claim:ledger` | `claimTo(address)` | Blind-signed; destination shown; value `0`; recipient **not** shown — the script prints it before signing and checks it against the receipt after |
| Refund to self | `npm run refund:ledger` | `refund()` | Blind-signed; destination shown; value `0` |
| Refund redirected | `RECIPIENT=0x... npm run refund:ledger` | `refundTo(address)` | Blind-signed; destination shown; value `0`; recipient **not** shown — the script prints it before signing and checks it against the receipt after |
| Request exit | `npm run request-exit:ledger` | `requestExit(uint256)` | Blind-signed; destination shown; value is `MAX_FEE_WEI`, the maximum fee sent, not the fee charged |
| Commit predeposit | `npm run commit-predeposit:ledger` | `commitAndPredeposit(...)` | Blind-signed; destination shown; value `1 ETH` |
| Open funding attempt | `npm run open-funding-attempt:ledger` | `openFundingAttempt(address[],uint256[])` | Blind-signed; destination shown; value `0` |
| Top up | `npm run top-up:ledger` | `topUpValidator()` | Blind-signed; destination shown; value `0` |
| Close expired attempt | `npm run close-expired-funding-attempt:ledger` | `closeExpiredFundingAttempt()` | Blind-signed; destination shown; value `0` |
| Sweep forwarder | `npm run sweep:ledger` | `sweep()` | Blind-signed; destination shown; value `0` |
| Deploy pool | `npm run deploy:ledger` | contract creation | Blind-signed; **no destination address exists**; creation bytecode plus constructor args; value `0` |
| Deploy forwarder | `npm run deploy-forwarder:ledger` | contract creation | Blind-signed; **no destination address exists**; creation bytecode plus constructor args; value `0` |

Funding is the only action with a clear-signed path, and it is the action that moves the most ETH. Everything else is blind-signed today.

The `request-exit` value deserves the extra words in the table. `MAX_FEE_WEI` is a ceiling the caller sets, not a payment: `requestExit(uint256)` reads the live EIP-7002 fee, reverts if it exceeds the cap, forwards exactly the live fee to the predeploy, and refunds the difference to the caller in the same transaction (`ValidatorFundingPool.requestExit`). The device shows what is sent, which is the ceiling. It defaults to twice the fee the script just read, so expect the device to show roughly double the fee you were quoted. What comes back is `MAX_FEE_WEI` minus whatever the fee is at the moment of inclusion: if the fee has not moved, that is half; if it rose in between, less; if it rose above the cap, the request reverts `ExitFeeTooHigh` and nothing is charged.

The two deployment rows are the weakest position on this list. A creation transaction gives the device nothing checkable: no destination, no decodable arguments, just a bytecode blob. You cannot verify a deployment on the device, so verify it after. Before publishing the pool address to anyone, independently confirm that the deployed runtime bytecode and the immutables baked into it match the build you intended — read `depositContract`, `withdrawalRequestPredeploy`, `operator`, `fundingWindowDuration`, and `withdrawalCredentials` back from the chain, compare the runtime code hash against a local build, and verify the source on Sourcify (`clear-signing/README.md` requires Sourcify verification anyway for registry submission). `npm run deploy` writes all five immutables into the deployment record, and every later script re-reads them from the live pool and refuses on a mismatch. That comparison only detects a deployment record that drifted from the pool, not a pool that was wrong from the first block — which is why every script also derives the withdrawal credentials from the pool's own address and compares the pool's runtime code against your local build. The bytecode comparison is automatic now; Sourcify verification and the repository's own provenance are still yours to check.

### The `claimTo` And `refundTo` Wart

`claimTo(address)` and `refundTo(address)` take the payout address as an ABI argument, not as the transaction destination. On a blind-signed transaction the device shows the destination as the pool and the value as `0`. The address that will actually receive every wei you are owed sits inside calldata the device does not render. A host that has been tampered with can substitute a recipient and the device gives you nothing to compare against. It is the same exposure as any blind-signed argument, but it is the one argument in this contract whose corruption redirects funds outright.

Mitigations, in order:

1. Prefer the no-argument variants. `claim()` and `refund()` both exist and always pay `msg.sender`, which is the device's own account. There is no unverifiable address to corrupt. `claim.ts` and `refund.ts` use them whenever `RECIPIENT` is unset or equals the signing account, so leaving `RECIPIENT` unset is the safe default.
2. Reach for `claimTo` / `refundTo` only when the signing account genuinely cannot receive ETH.
3. When you must redirect, derive the recipient independently on a second machine and compare it against the address the script prints before you approve on the device. `claim` and `refund` print it *before* they compose the transaction — `claim pool: <address>`, `claim recipient: <address>`, `claim amount: <wei>`, followed on the redirected path by a multi-line notice saying in as many words that this address rides in calldata the device will not render and must be compared now. This detects a tampered env file; it does not detect a tampered signing host, which composed that printed line too.
4. Read the confirmation after mining. `assertPayoutReachedRecipient` decodes the pool's own `Claimed` / `Refunded` event out of the receipt — `recipient` is an indexed topic on both — and the command fails, naming the intended address and the actual one, if they differ. It is the same detection-not-prevention shape as the funding credit check: the ETH has already moved, and what it converts is a silent redirection into a named failure.
5. An ERC-7730 descriptor (see below) lets wallets that support it render the recipient. It does not help the Hardhat Ledger path, which requests no descriptor resolution.

### ERC-7730 Clear-Signing Descriptor

`clear-signing/` holds an ERC-7730 descriptor for the pool's user-facing functions. Submitting it to Ledger's registry is what makes wallets that consult the registry render arguments — the `claimTo` recipient in particular — instead of a data hash.

It does not change what `npm run *:ledger` shows. `@nomicfoundation/hardhat-ledger` calls `ledgerService.resolveTransaction(tx, {}, {})` with an empty resolution config, so it requests no external-plugin, token, or NFT descriptor for any transaction. Hardhat calldata paths stay blind-signed regardless of what is published. The descriptor is for participants who sign the same calls through Ledger Live or another registry-aware wallet.

See `clear-signing/README.md` for the deployment binding and registry submission steps.

## Commands

Install dependencies and run the local checks:

```bash
npm ci
npm run build
npm test
```

`npm ci`, not `npm install`: it installs exactly the tree `package-lock.json` names and fails if the lockfile and `package.json` disagree, where `npm install` is free to resolve a newer version and rewrite the lockfile underneath you. What runs the capital paths, verifies the pool's runtime code, and computes deposit data should be the audited tree, not whatever resolved today. Use `npm install` only when a dependency update is the change you intend to make, and commit the resulting lockfile as part of it.

### End-To-End Command Tests

`npm test` covers the contract and the helpers the commands are built from. The commands themselves — the order in which a script calls those helpers, which branch it takes, and the lines it prints — are covered separately:

```bash
npm run test:e2e
```

It takes about forty seconds and needs nothing but this checkout. Each case runs a command exactly as `package.json` runs it, as a real child process with a controlled environment, against a local `hardhat node` and a deterministic mock beacon node that the harness starts and tears down itself. The local chain carries the real mainnet deposit contract and the real EIP-7002 predeploy at their real mainnet addresses, and refuses to start unless each hashes to the expectation its own `test-e2e/fixtures/*.json` records — derived from the upstream artifact rather than imported from the pin, so the harness states independently what it is running. `npm test` closes the loop: `test/CanonicalSystemContracts.ts` requires those fixture expectations, the literals the command tests hold the deployment record to, and `CANONICAL_SYSTEM_CONTRACTS` in `scripts/lib/common.ts` to be the same values, so a copy that drifts fails the unit suite instead of leaving a harness that proves nothing.

It is kept out of `npm test` on purpose, so the unit suite stays fast enough to run constantly. Run both before proposing a change to anything in `scripts/`.

`SECURITY.md` §5 lists what the harness covers and the two paths it does not: the Ledger hardware paths, and the true mid-flight top-up race.

Deploy:

```bash
RPC_URL=http://localhost:8545 \
PRIVATE_KEY=0x... \
FUNDING_WINDOW_SECONDS=86400 \
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
RPC_URL=http://localhost:8545 npm run status
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
RPC_URL=http://localhost:8545 npm run status
```

The `PRIVATE_KEY=0x...` shown above is the development form. On mainnet, drop it and use `npm run <action>:ledger` with `LEDGER_ADDRESS` set, or store `RPC_URL` and `PRIVATE_KEY` in the encrypted keystore. See "Signing And Key Custody".

Environment variables. Every numeric one — amounts, fees, windows, targets — must be a plain unsigned decimal integer: no `0x` prefix, no sign, no leading zeros, no separators, no surrounding whitespace. `0x20` is a parse error naming the variable, not thirty-two.

Use `https://` for `RPC_URL` and `BEACON_NODE_URL` unless the node is on loopback. Over plaintext `http://` to any other host, everything a dishonest endpoint could do — described in [`SECURITY.md`](SECURITY.md) §2 — is available to anyone on the network path instead. Every command prints a loud warning when either URL is plaintext to a non-loopback host; it is a warning rather than a refusal because a LAN node over plain HTTP is a legitimate setup, and loopback is never warned about. The RPC URL it checks is the connection's own resolved endpoint, so an `RPC_URL` kept in the encrypted keystore — where it never reaches `process.env` — is checked exactly like an exported one.

They divide into two classes, and the class matters more than any individual entry.

### Deploy-Time Variables

Four variables are read by `npm run deploy` and by nothing else. Each becomes an `immutable` in the pool's constructor, so what `deploy` was given is what the pool has for the rest of its life; a later command that sets one is not changing anything, and the only way to change one is to deploy a new pool — which strands the first pool's 1 ETH predeposit. Every other command reads these values back *from the pool* and refuses if the deployment record disagrees.

- `DEPOSIT_CONTRACT`: deposit contract address. Defaults to mainnet's.
- `WITHDRAWAL_REQUEST_PREDEPLOY`: EIP-7002 predeploy address. Defaults to mainnet's.
- `OPERATOR`: operator address; defaults to the deployer.
- `FUNDING_WINDOW_SECONDS`: **required** by `npm run deploy`. The funding window, in seconds, baked into the pool at deploy time and immutable thereafter. It is **not** per attempt: `openFundingAttempt` takes no duration, and every attempt this pool ever opens gets a deadline of `block.timestamp + fundingWindowDuration`. Choose it at deployment as a security decision — a short window bounds how long a listed participant who never funds can lock everyone else's capital ([`SECURITY.md`](SECURITY.md) §2, "Participants"). Unset or empty is fatal naming the variable, before any RPC read; there is no default, because the one it used to have (`86400`) was a permanent choice nobody made, and the error quotes it as the explicit form to type. It is bounded to `3600`..`31536000` — one hour to one year. Below an hour an attempt expires before the listed participants could read the funding review and approve on a device; above a year it bounds nothing, and further up it stops being a bad window and becomes a brick, since the deadline is checked arithmetic and a window near the uint256 maximum makes every attempt revert on overflow forever, on a pool whose 1 ETH predeposit is already stranded. The contract accepts anything but zero and `contracts/` is frozen, so the bounds live in the command. `deploy` prints `Funding window (immutable): <n>s` before deploying, `status` prints it read back from the pool, and setting the variable in `open-funding-attempt`'s environment is a fatal error rather than a silent no-op — that command prints the pool's actual window next to the deadline it sets.

### Per-Command Variables

- `RPC_URL`: execution-layer JSON-RPC endpoint used by every command.
- `DEPLOYMENT_FILE`: path to the deployment record; defaults to `deployments/latest.json`. This selects the *subject* of every check a command makes, not merely where a file lives: the record names the pool, and the chain-id comparison, the five immutables, both system-contract code hashes, the canonicity pin, the forwarder binding, and the address capital is sent to are all read from — or compared against — the record this variable chooses. `deploy` writes it; every other command reads it. Every command prints the resolved path in its opening lines, next to the active-signer line, so which record a run acted on is never a guess.
- `DEPOSIT_DATA_FILE`: path to the deposit-data file; defaults to `deposit-data.json`. It selects the pubkey, signatures, and deposit-data roots that `commit-predeposit` commits, that `fund` compares against the on-chain commitment before sending, and that `top-up` and `request-exit` cross-check the committed pubkey against. `request-exit` is the one command that only *warns* when the file is unreadable and proceeds on the RPC's value, because the recovery path must not be disableable by a missing file. Like `DEPLOYMENT_FILE` it selects the *subject* of the checks rather than waiving one — the record chooses which pool, this chooses which validator — so each of those four commands prints `Deposit data file: <path>` before it opens the file, and which file a run acted on is never a guess. `request-exit`'s read is the try-guarded one: it announces the path the same way and warns rather than failing when the file is unreadable.
- `EXPECTED_POOL`: optional declared pool address. Set it and every command that reads a record requires the record's `pool` to equal it, case-insensitively, before any other check runs; `fund` re-checks it in the final on-chain re-read immediately before signing. `deploy` reads no record — it writes one — and treats a declaration as a redeploy guard instead: a fresh deployment can never be the pool you already named, so it refuses before writing the record rather than overwriting the record that declaration was about. This is the pin for `DEPLOYMENT_FILE`: a record for a different pool — stale, swapped, or simply the wrong path in the environment — otherwise passes every check in the list above while describing a pool you did not mean. An unparseable value is fatal naming the variable, never ignored.
- `EXPECTED_FORWARDER`: optional declared fee-recipient forwarder address. `DEPLOYMENT_FILE` names the forwarder as freely as it names the pool, and the forwarder is what a validator client pays every proposal's execution-layer rewards to. Set it and every command that reads a record requires the record's forwarder to equal it, case-insensitively — including a record that names no forwarder at all, which is fatal rather than a silent pass, because that is the pre-`deploy-forwarder` record and pointing at it is the mistake the pin exists to catch. `deploy-forwarder` writes that field rather than reading it, and treats a declaration as a redeploy guard, exactly as `deploy` treats `EXPECTED_POOL`: a declaration names a forwarder that already exists and a fresh deployment can never be it, so the command refuses while the variable is set at all — before a single request, so nothing is left deployed and unrecorded. If replacing the forwarder is what you meant, unset it, and remember that the validator client's `fee_recipient` still points at the old address until you change that too. An unparseable value is fatal naming the variable.
- `LEDGER_ADDRESS`: Ledger account address for the `ledger` network; required by every `:ledger` command.
- `EXPECTED_SIGNER`: optional declared signing address. Every command prints the account it is about to sign with; set this and the command additionally refuses to sign with anything else, on any network including `ledger`. It is the check that catches a forgotten `PRIVATE_KEY` in the environment outranking a keystore entry.
- `FUND_VIA_TRANSFER`: `1` forces `fund` to send a zero-calldata transfer, `0` forces the `fund()` calldata path. Defaults to the transfer path on the `ledger` network and to calldata elsewhere. It waives no check — every preflight, every `EXPECTED_*` pin, the final on-chain re-read, and the receipt-log credit confirmation run identically on both routes — but `=1` selects the route with no contract revert underneath it: `fund()` calldata reverts `InvalidState` on a pool that has already topped up, while a plain transfer in that state is accepted by `receive()` as pool proceeds, credited to nobody (see "Plain-Transfer Funding — The One Divergence"). Decide it per run, against the pool state you just read, rather than exporting it once in a shell profile: the value that was right for one run is the donation case in the next.
- `PARTICIPANTS`: **required** by `open-funding-attempt`. Comma-separated addresses; must include the operator. Unset or empty is a fatal error naming the variable, before any RPC read — there is no default, because the one it used to have (the operator alone, at the full 32 ETH) is indistinguishable on chain from an attempt that was meant that way. A deliberate single-participant attempt is written out: `PARTICIPANTS=<operator address> FUNDING_TARGETS_GWEI=32000000000`.
- `FUNDING_TARGETS_GWEI`: **required** by `open-funding-attempt`. Comma-separated final economic weights, positionally matching `PARTICIPANTS` and summing to `32000000000`. Unset or empty is fatal naming the variable, for the same reason and with the same single-participant form spelled out; a length mismatch against `PARTICIPANTS` is fatal too, since target *i* belongs to participant *i* and a mismatch has no reading.
- `AMOUNT_WEI`: optional partial funding amount for `fund`; defaults to the caller's entire remaining allocation and may not exceed it.
- `EXPECTED_PUBKEY`: optional declared validator pubkey for `commit-predeposit`. This is the pin for `DEPOSIT_DATA_FILE`, and it is what `EXPECTED_POOL` is for `DEPLOYMENT_FILE`. `fund` and `top-up` need no declaration because they compare the file against a commitment that already exists on chain; `commit-predeposit` *creates* that commitment, so nothing on chain can check it and the pubkey the file names becomes this pool's validator permanently. Set it and the command requires the file's 1 ETH predeposit entry to name exactly that pubkey, before any RPC read; a value that is not 48 bytes of hex is fatal naming the variable. Leave it unset and the command prints the pubkey it is about to commit and warns loudly that nothing independent of the file has checked it.
- `EXPECTED_FUNDING_ATTEMPT`: optional `fund` check for the active attempt number.
- `EXPECTED_MY_TARGET_GWEI`: optional `fund` check for the caller's current-attempt target.
- `EXPECTED_OPERATOR_TARGET_GWEI`: optional `fund` check for the operator's current-attempt target.
- `EXPECTED_DEADLINE_BEFORE`: optional `fund` check requiring the funding deadline to be at or before this Unix timestamp.
- `DEPOSIT_NETWORK_NAME`: optional deposit-file metadata check.
- `RECIPIENT`: optional nonzero, non-pool recipient for `claim` and `refund`. Unset, both commands call the no-argument `claim()` / `refund()`, which pay `msg.sender` and put no address in calldata at all. Set, they call `claimTo(address)` / `refundTo(address)`, and that address is an ABI argument no hardware wallet renders — so both commands print the pool, the recipient, and the amount before composing the transaction, with a loud notice on the redirected path, and both re-check the recipient against the pool's own `Claimed` / `Refunded` event in the mined receipt. See "The `claimTo` And `refundTo` Wart".
- `MAX_FEE_WEI`: optional cap on the EIP-7002 exit request fee for `request-exit`, and the value the transaction carries. Defaults to twice the fee read immediately before sending, so an ordinary fee uptick between the read and inclusion does not revert `ExitFeeTooHigh`. Only the live fee is forwarded to the predeploy; the rest is refunded in the same transaction. A value below the currently observed fee is rejected before signing.
- `BEACON_NODE_URL`: beacon REST URL for validator predeposit confirmation, funding and top-up preflights, and the advisory exit preflight; required by `commit-predeposit`, `fund`, and `top-up`.
- `REFUND_PARTICIPANTS`: optional comma-separated addresses for `status` to display refund-only claimants that are no longer in the current funding attempt.

## License

MIT
