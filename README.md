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

1. Deploy the pool with the operator and system contract addresses.
2. Read the pool address and its withdrawal credentials.
3. Generate two deposit-data entries for the same validator pubkey and the pool's withdrawal credentials:
   - `1000000000` Gwei predeposit;
   - `31000000000` Gwei top-up.
4. The operator calls `commitAndPredeposit()` with the deposit data and sends exactly `1 ETH`.
5. Participants wait until beacon state shows the validator pubkey exists with the pool's withdrawal credentials.
6. The operator opens a fixed funding attempt whose economic targets sum to `32 ETH` and include the operator with at least `1 ETH`.
7. Participants fund their caps in the current attempt. The operator's cap is its target minus the credited `1 ETH` predeposit.
8. The operator calls `topUpValidator()` once exactly `31 ETH` is actively funded, and before the deadline.
9. After top-up, any ETH balance in the pool, excluding outstanding failed-attempt refunds, is claimable pro rata by final economic weight.

If a funding attempt expires before top-up, anyone can close it. Active contributions become passive refund claims. The operator may open a new funding attempt without waiting for those refunds to be withdrawn. Refund claims are never rolled into later attempts automatically.

The accounting rules behind steps 7 to 9 — cumulative entitlement, rounding dust, refund liabilities, and what counts as pool proceeds — are in [`ACCOUNTING.md`](ACCOUNTING.md).

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

The contract only enforces custody and pro-rata distribution of ETH that reaches the pool. Consensus withdrawals and exited principal reach the pool because the withdrawal credentials point to the pool. EL priority fees and MEV follow the operator-controlled `fee_recipient`, never the withdrawal credentials, and remain outside anything this contract can enforce. The default expectation is that the operator keeps those rewards as hardware incentive.

Do not configure the pool itself as `fee_recipient`. Its `receive()` is state-dependent and rejects ordinary transfers before funding or top-up, which is the wrong property for a set-and-forget validator-client destination. It is also a heavier recipient than a baseline ETH transfer. If the group explicitly decides to pool EL rewards, use the optional `FeeRecipientForwarder` sidecar described below.

### Optional EL Rewards Forwarder

`FeeRecipientForwarder` is a fixed-destination sidecar for groups that choose to distribute EL priority fees and MEV through the pool. Its `receive()` is empty and unconditional, so a builder payment transaction does not depend on pool lifecycle state and stays near baseline transfer gas. Its immutable `pool` is validated at construction against the full pool-owned withdrawal credentials. There is no owner, pause, upgrade, rescue, arbitrary call, or alternate recipient.

Deploy it against the pool recorded in the deployment file with `npm run deploy-forwarder`. Point the validator client's `fee_recipient` at the recorded forwarder address only after the pool is topped up, never before: the forwarder always accepts ETH, but `sweep()` cannot deliver it while the pool still rejects ordinary transfers, and there is no rescue path if the pool never reaches `ToppedUp`.

Anyone can run `npm run sweep`. It moves the forwarder's entire balance to the immutable pool, where the ETH becomes pool proceeds distributed pro rata by final credited weight. A zero-balance sweep reverts, and a sweep rejected by the pool remains permissionlessly retryable.

Pooling EL rewards changes the group's economics and must be an explicit group decision. The sidecar makes pooling possible and verifiable when it is configured, but it does not make MEV trustless or enforce the configuration. The operator still controls `fee_recipient` and can change or unset it at any time. The operator is also responsible for confirming contract-recipient behavior with the actual relay and builder set.

The deployment, runtime-code, and sweep-reconciliation checks the forwarder commands run are described in [`COMMANDS.md`](COMMANDS.md).

## Trust And Incentives

The operator bears the first loss of coordination failure. Before participants can fund, the operator must commit validator data and send the protocol-minimum `1 ETH` predeposit. That ETH is not refundable from this contract. If the group never completes the `31 ETH` top-up, the operator's predeposit remains at risk unless the validator is later fully funded, activated, and exited.

That upfront cost is what locks in the cross-layer safety property participants care about. Participants wait for beacon state to show the committed pubkey with the pool's `0x01` withdrawal credentials before funding. Ethereum consensus stores the withdrawal credentials when a validator is created, and later deposits for the same pubkey increase the validator balance rather than replacing those credentials. The relevant spec points are the [`0x01` withdrawal credential shape](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/phase0/validator.md#eth1_address_withdrawal_prefix), validator creation [storing `withdrawal_credentials`](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#modified-get_validator_from_deposit), and existing-pubkey deposit handling that only [increases balance](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#new-apply_pending_deposit).

Participants have no capital at risk until they fund after that verification. Once they fund, they are incentivized to complete the attempt promptly so dormant ETH starts earning consensus rewards. Only the operator can submit the top-up, so funding windows should be intentionally short. If an attempt expires before top-up, active funding becomes refundable and the operator can reopen funding with a different participant set.

Poor validator operation is still an operator trust boundary. The intended incentive alignment depends on the configured operator target: the contract enforces only that the operator has at least the `1 ETH` predeposit credited as economic weight. Groups that rely on operator self-exposure should configure a larger operator target. Downtime, slashing, or deliberate misoperation then harms the operator's own claim as well as everyone else's. This reduces but does not remove operator trust.

As a general recommendation, an operator target of at least `16 ETH` — a majority of the `32 ETH` validator — makes one piece of arithmetic unambiguous: every loss the pool takes to a penalty, a slashing, or missed rewards is shared pro rata by credited weight, so at half or more of the weight the operator bears **at least half of any loss that lands in the pool**. That is the whole of the provable claim, and it is worth not overstating: it does not say the operator cannot come out ahead by operating badly. Gains that never enter the pool are not bounded by pool weight at all — a bribe, or MEV diverted away from the configured `fee_recipient`, both of which are described above as things the operator controls and this contract cannot reach. The threshold bounds the operator's share of in-pool losses; it does not bound their outside options. Below that threshold even the in-pool half of the argument fails, and the operator can be the party with the least to lose from their own misoperation. It is a coordination choice, not an enforced one: nothing in the contract requires it beyond the `1 ETH` floor, and it does not address deliberate abandonment, only makes it self-punishing.

The unilateral escape hatch is EIP-7002. The operator can request exits before or after top-up because the operator bears the predeposit exposure. After top-up, final credited participants can request a full exit without operator permission. Current funding-attempt participants recover through the funding deadline and `refundTo()` if top-up does not happen; refund-only holders cannot request exits for a later validator they did not fund. Consensus processing still enforces validator-state preconditions, so execution-layer accepted requests can be ignored until those conditions are met; the contract therefore records attempts and allows retries. See the consensus [`process_withdrawal_request`](https://github.com/ethereum/consensus-specs/blob/5fa6edcca8ab4cf548653e6680b17b9d3e04d225/specs/electra/beacon-chain.md#new-process_withdrawal_request) flow.

This is not a complete validator exit gate. The validator active key can still sign a consensus-layer voluntary exit outside this contract, and anyone with a valid pre-signed voluntary exit can submit it. If the withdrawal credentials are correct, exited funds still return to the pool, but timing and opportunity cost can bypass the pool's local EIP-7002 caller restrictions.

## Verify Before You Fund

Do not fund until beacon state confirms that the predeposit locked the validator pubkey to the pool's withdrawal credentials. Before funding, check that:

- the on-chain committed pubkey, signatures, and roots match the deposit-data file;
- both deposit-data entries use the pool's `0x01` withdrawal credentials, one for exactly `1000000000` Gwei and the other for exactly `31000000000` Gwei;
- both deposit data roots recompute, both BLS deposit signatures verify against the `genesis_fork_version` this repository pins for mainnet and requires the beacon node to report, and the network metadata matches the intended chain;
- beacon state shows the committed pubkey with the pool's withdrawal credentials;
- the pool's `withdrawalCredentials` are `0x01`, eleven zero bytes, then the pool's own address — anything else means the validator's consensus withdrawals do not pay this pool;
- the pool's deployed runtime bytecode is the bytecode this repository builds, and the source is verified on Sourcify.

The last two are the only checks that are not circular. Everything else compares an operator-supplied deployment record against the contract that record names, and those two can agree perfectly while describing a pool nobody ever looked at. The repository scripts run the credential derivation and the bytecode comparison automatically on every capital path, along with the beacon preflights. What they cannot check for you: that this checkout is the genuine repository, and that the deployed source is verified on Sourcify — confirm both independently.

Deposit data is not secret — it is designed to be publishable and becomes public when submitted to the deposit contract. The operator must not share validator private keys, mnemonics, keystore passwords, remote signer credentials, or validator-client secrets.

[`VERIFICATION.md`](VERIFICATION.md) is the full treatment: what each check proves, how the runtime-code comparison works, the beacon preflight in detail, and the cross-layer caveats around BLS, pubkey freshness, and direct validator deposits.

## Review Status

The contracts have **not** been audited by an independent security firm.

What did happen: the author pressure-tested the safety model, the economic incentive alignment, and the trust boundaries over many rounds of blind, adversarial review across different AI model families, continuing until fresh reviews stopped finding new issues. That is a real process and it found real problems, but it is not an independent audit and this repository does not claim it is.

The repository is deliberately over-documented and defensive so that you — and any tools you trust — can review it yourselves. See [`SECURITY.md`](SECURITY.md) "Review status" for the fuller statement.

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
| ETH is forced into the pool | It follows the forced-ETH rules in [`ACCOUNTING.md`](ACCOUNTING.md); no sender rescue exists. |
| Forwarder receives ETH before pool top-up | Funds remain in the forwarder until a permissionless sweep succeeds; they are stranded if the pool never tops up. |

## Getting Started

Install dependencies and run the local checks:

```bash
npm ci
npm run build
npm test
```

`npm ci`, not `npm install`: it installs exactly the tree `package-lock.json` names, where `npm install` is free to resolve a newer version and rewrite the lockfile underneath you. What runs the capital paths should be the exact dependency tree the release was tested with. [`COMMANDS.md`](COMMANDS.md) has the full rationale.

There is also an end-to-end suite that runs each command as a real child process against a local chain and a mock beacon node: `npm run test:e2e`. [`COMMANDS.md`](COMMANDS.md) describes what it covers.

The examples below use the development signing form — `PRIVATE_KEY` in the environment, which is plaintext in your shell and process listings. On mainnet, drop it and sign with a Ledger or the encrypted keystore; see the note at the end of this section and [`SIGNING.md`](SIGNING.md).

Deploy:

```bash
RPC_URL=http://localhost:8545 \
PRIVATE_KEY=0x... \
FUNDING_WINDOW_SECONDS=86400 \
npm run deploy
```

Generate predeposit and top-up deposit data with the printed pool withdrawal credentials, then commit the validator and submit the operator-funded predeposit:

```bash
RPC_URL=http://localhost:8545 \
BEACON_NODE_URL=http://localhost:5052 \
PRIVATE_KEY=0x... \
npm run commit-predeposit
```

`commit-predeposit`, `fund`, and `top-up` require `BEACON_NODE_URL` — a beacon node's REST API — because each one refuses to move capital without beacon confirmation.

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
RPC_URL=http://localhost:8545 BEACON_NODE_URL=http://localhost:5052 PRIVATE_KEY=0x... npm run fund
RPC_URL=http://localhost:8545 BEACON_NODE_URL=http://localhost:5052 PRIVATE_KEY=0x... npm run top-up
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

The `PRIVATE_KEY=0x...` shown above is the development form. On mainnet, drop it and use `npm run <action>:ledger` with `LEDGER_ADDRESS` set, or store `RPC_URL` and `PRIVATE_KEY` in the encrypted keystore — see [`SIGNING.md`](SIGNING.md). Set `EXPECTED_CHAIN_ID=1` there too: it pins the connection to mainnet at the transport layer, so a command against an endpoint on some other chain refuses before it composes a transaction.

Every environment variable, every default, and what each command prints when it fails are in [`COMMANDS.md`](COMMANDS.md).

## Documentation

- [`SECURITY.md`](SECURITY.md) — the security model: system and trust model, enforced invariants and where each is enforced, operational assumptions, and residual risks. The primary reference; read it before putting capital in.
- [`VERIFICATION.md`](VERIFICATION.md) — what participants should verify before funding, how the runtime-code authenticity check works, the beacon preflights, and the cross-layer caveats.
- [`ACCOUNTING.md`](ACCOUNTING.md) — the accounting model, balance increases that happen without a call, funding by plain transfer and the one state where it diverges from `fund()`, and event reconciliation.
- [`SIGNING.md`](SIGNING.md) — signing and key custody: Ledger, encrypted keystore, what the device actually shows, and the `claimTo` / `refundTo` wart.
- [`COMMANDS.md`](COMMANDS.md) — the command reference: defaults, the full environment-variable reference, forwarder operational detail, the end-to-end suite, and what a failure prints.

## License

MIT
