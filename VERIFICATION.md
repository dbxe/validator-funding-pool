# Verifying The Pool And The Validator

This document is the full version of the README's "Verify Before You Fund". Participants should complete it before sending ETH.

## What To Verify Before Funding

This section lists the checks that stand between a deployment record and your capital, and explains why the last two are the only ones that break the circularity between the deployment record and the pool it names.

Participants should not fund until beacon state confirms the predeposit locked the validator pubkey to the pool withdrawal credentials. Before funding, participants should verify:

- the on-chain committed pubkey, signatures, and roots match the deposit-data file;
- both deposit-data entries use the pool's `0x01` withdrawal credentials;
- one entry is exactly `1000000000` Gwei and the other is exactly `31000000000` Gwei;
- both deposit data roots recompute correctly;
- both BLS deposit signatures verify against the `genesis_fork_version` this repository pins for mainnet and requires the beacon node to report;
- network metadata matches the intended chain;
- beacon state shows the committed pubkey with the pool withdrawal credentials;
- the pool's `withdrawalCredentials` are `0x01`, eleven zero bytes, then the pool's own address — anything else means the validator's consensus withdrawals do not pay this pool;
- the pool's deployed runtime bytecode is the bytecode this repository builds, and the source is verified on Sourcify.

### Why The Last Two Are Different

The last two are the only checks that are not circular. Everything else compares an operator-supplied deployment record against the contract that record names, and those two can agree perfectly while describing a pool nobody has checked.

The scripts now perform both automatically. The next section is what they do.

## Pool Authenticity: The Runtime-Code Check

This section establishes that the pool you are about to fund is the contract this repository builds, and not merely a contract that answers questions the way the deployment record says it should.

### What `assertDeploymentMatchesPool` Derives

`assertDeploymentMatchesPool` derives the credentials from the pool's address rather than trusting `withdrawalCredentials()`, and uses the derived value everywhere a capital path needs credentials.

### What `assertRuntimeCodeMatchesLocalBuild` Compares

`assertRuntimeCodeMatchesLocalBuild` reads the pool's runtime code from the chain and compares it against your own `npm run build` output, masking only the byte ranges the build artifact marks as immutables — so that two deployments differing solely in their constructor arguments both pass and a single changed instruction does not.

The check is fatal, with a `npm run build` instruction, when no artifact exists — in practice a rare branch, since `hardhat run` compiles the project before it runs a script. It reports which artifact and which of `hardhat.config.ts`'s two solidity profiles matched.

Both contracts this repository deploys are verified the same way; see "Optional EL Rewards Forwarder" in `README.md` for the sidecar.

### Why No Environment Variable Can Supply A Candidate Artifact

The only artifact the check will ever read is the one hardhat built in this checkout. No environment variable can add another candidate, because a candidate supplies both the bytecode the chain is compared against and the byte ranges the comparison ignores — and a candidate that supplies both can always be made to match.

### The Immutable-Range Plausibility Bounds

The declared immutable ranges are themselves checked for plausibility before anything is masked: they must be disjoint and must total no more than 2048 bytes.

A real build of this contract declares 608 — solc emits a 32-byte range per immutable *reference site*, and the five immutables are read at 19 sites under both profiles.

### Build Profiles: Verifying Against Production

Hardhat keeps only the last-built profile's artifacts, and `hardhat run` recompiles with the default profile before it runs a script — so a separate `npx hardhat compile --build-profile production` is undone by the very next command.

Verifying against the production profile means passing the profile to the command itself:

```bash
npm run fund -- --build-profile production
```

That trailing global option is accepted after the pinned `--network`, verified by experiment on hardhat 3.12.0, and it leaves the artifact on the production profile afterwards; `SECURITY.md` §5 records the measurement.

### The Provenance Caveat

Verifying the runtime code proves the pool runs the contract *this checkout* builds. It does not prove this checkout is the genuine repository: confirm the repository's provenance independently, and confirm the deployed source on Sourcify.

## Beacon Confirmation

This section covers what the repository scripts check against the beacon chain before capital moves, and how strict each check is. Beacon confirmation is the cross-layer evidence that the predeposit really did bind the validator to this pool.

### These Values Are Not Private

Deposit data is designed to be publishable and becomes public when submitted to the deposit contract. The operator must not share validator private keys, mnemonics, keystore passwords, remote signer credentials, or validator-client secrets.

### Pinning `genesis_fork_version`

The `genesis_fork_version` is part of the domain a validator's BLS deposit signature is computed over. This repository pins mainnet's value — `0x00000000`, from consensus-specs `configs/mainnet.yaml` — and requires the connected beacon node to report it. Both deposit-data entries must declare the same value, and it is what verifies the deposit roots and BLS signatures.

Requiring only that the node and the deposit file agree with each other would check nothing when the same party supplies both: a deposit signed under the wrong fork version is still accepted by the deposit contract, which verifies no BLS signature, and the validator would simply never activate.

On a chain this repository does not pin — a devnet — set `GENESIS_FORK_VERSION` to that network's value and it is enforced the same way. It cannot overrule a pinned chain: a declaration that disagrees with the pin is a fatal error, not an override. If nothing pins the chain and nothing is declared, the scripts print a warning saying the fork version is whatever the node reports.

### What `fund.ts` Does Before Sending

`fund.ts` performs this chain check before looking up the validator, compares the local deposit-data file to the on-chain commitment before sending ETH, prints the current funding attempt, allocation, and operator target percentage, and supports optional expected-value checks for participants who want an extra local guardrail.

Those `EXPECTED_*` checks run twice: once against the review you read, and again in the final on-chain re-read immediately before signing, which also requires the funding attempt to be the same one the review described.

After the transaction is mined, `fund` reads the receipt's own logs and requires the pool to have credited the signer with exactly the amount sent. Scripts that use withdrawal credentials read them from the live pool and compare them to the deployment record before relying on either value.

### Mandatory On Every Capital Path

Beacon confirmation is mandatory in the supported repository scripts on every path that puts capital at risk: `commit-predeposit`, `fund`, and `top-up`. These paths require `BEACON_NODE_URL`, and no environment variable waives any part of it.

`fund` and `top-up` run the identical preflight. Credentials are confirmed at a settled state and re-confirmed at head; head state must also show a fresh predeposit: no slashing, activation, activation-eligibility, exit, and withdrawable epochs all equal to `FAR_FUTURE_EPOCH`, and a balance of at least the 1,000,000,000 Gwei predeposit. These checks use the consensus fields rather than the Beacon API status label.

### The One Condition A Person Resolves: Excess Balance

A head balance *above* 1 ETH is the one condition the person running the command resolves rather than a hard failure, and only once every other assertion has passed.

The script prints why the excess is harmless and then requires an interactive typed confirmation: whoever runs `fund` or `top-up` types the exact observed balance in Gwei on a terminal. No environment variable, flag, or acknowledgement string substitutes for it, and a non-interactive stdin fails instead of proceeding.

Once the balance is confirmed the entire head-state preflight is re-run against a fresh fetch — node health, credentials, slashing, all four epochs, balance — and the fresh balance must still equal the confirmed value exactly; a validator whose state moved while the prompt was open is fatal, not waived.

The confirmation waives nothing — credentials at both states, the slashing flag, all four epochs, and the 1 ETH balance floor stay fatal on both legs — and the confirmed run's final log line names the confirmed excess balance instead of reporting a plain pass. See "Hard Failure On Excess Predeposit Balance" in `SECURITY.md` §7.

### Three Things About How Those Beacon Reads Are Made

The validator body must echo the pubkey that was asked about, so a proxy that answers every query with one particular validator's record cannot satisfy the credential, balance, slashing, and epoch checks with a body about a different validator.

`commit-predeposit` establishes the committed pubkey's absence positively — HTTP 200 and an empty validator list — rather than reading a 404 as "not there", because a 404 is equally what a wrong path or an endpoint that is not a beacon node returns.

And a path component in `BEACON_NODE_URL` is preserved, so a hosted endpoint of the form `https://host/eth-beacon-node/<key>` is queried under that prefix instead of at the host root.

### The Final Re-Read, And What It Cannot Close

`fund` and `top-up` re-run the entire head-state preflight once more as the last thing they do before composing the transaction, and require the balance to equal the value the full preflight settled on. That removes the largest part of the window — the funding review and everything you read before deciding.

It does not shrink the rest to seconds: after the recheck come hardhat's fee, gas-limit, and nonce round trips and, on the Ledger path, the device confirmation, which is a person pressing buttons and is bounded by nothing. No recheck after the approval is possible, because the plugin signs and broadcasts in one call. The stretch from signing to inclusion is beyond any of it. [`SECURITY.md`](SECURITY.md) §5 states the whole window and the deferred pipeline that would close the device half.

### `request-exit` Is Advisory By Design

The `request-exit` recovery path deliberately treats its beacon preflight as advisory: without `BEACON_NODE_URL`, it warns and proceeds so an unavailable beacon API cannot disable the escape hatch.

With a beacon URL, `request-exit.ts` uses head state and beacon spec constants to check that the validator is active, unexited, unslashed, and old enough for consensus to honor an EIP-7002 full-exit request.

## Cross-Layer Caveats

This section collects the places where the contract's guarantees stop at the execution layer and something on the consensus layer, or outside the pool entirely, takes over. Each one is a limit to understand rather than a defect to fix.

### Deposit Data And BLS

The deposit contract checks the deposit data root but does not verify BLS proof-of-possession. Repository scripts reject deposit data unless the root recomputes and the BLS deposit signature verifies for the deposit message and fork version.

Solidity does not verify BLS signatures. Bypassing the scripts and submitting invalid-but-well-formed deposit data can trap ETH in the deposit contract or fail to create the intended beacon validator.

### Pubkey Freshness

The contract cannot prove that a validator pubkey was globally unused before predeposit. Participants should rely on beacon confirmation before funding: if beacon state shows the committed pubkey with pool withdrawal credentials, later deposits for the same pubkey cannot switch credentials away from the pool.

This design intentionally avoids deposit-log scanning. A log scan can catch some pending EL deposits, but it is not a complete mempool-race solution. The practical safety boundary is that participants fund only after the predeposit is processed and visible in beacon state with pool credentials.

### Direct Validator Deposits

Only ETH sent through the pool is credited as participant funding. A third party can deposit directly to the same validator pubkey through the deposit contract after the pool credentials are locked. That does not change the validator withdrawal credentials, so it is not a theft path against pool participants, but it can affect validator activation timing, partial withdrawals, and reconciliation. Treat direct deposits as uncredited external top-ups or donations.

A direct deposit before top-up raises the head balance above the 1 ETH predeposit, which the `fund` and `top-up` preflights surface as an interactive typed confirmation rather than a failure. See "Hard Failure On Excess Predeposit Balance" in `SECURITY.md` §7.

### EIP-7002 Exit Attempts

EIP-7002 requests accepted by the execution-layer predeploy can still be ignored by consensus-layer processing. The contract records attempts and allows retries. Request fees are paid by the caller, not from pool proceeds. `request-exit.ts` checks head beacon state before submitting, including the active status, `exit_epoch`, slashing flag, and `SHARD_COMMITTEE_PERIOD` age requirement, but the Solidity contract cannot enforce those consensus-state predicates.

### System Contract Addresses

Every operational script reads all five pool immutables and refuses if the deployment record disagrees on the deposit contract, withdrawal-request predeploy, operator, withdrawal credentials, or funding-window duration. Code hashes are then computed at the two system addresses read from the live pool and checked against the record.

On Ethereum mainnet, the scripts additionally pin both system-contract addresses and runtime code hashes to known canonical values from a source independent of the pool and record. This canonicity check catches a pool and record that agree with each other but were both configured with a false system contract. On an unrecognized test or development chain, the scripts keep enforcing record-to-pool consistency and print an explicit warning that canonicity is unverified.

### Future Protocol Operations

The contract is intentionally narrow. It supports pool-owned `0x01` withdrawal credentials and EIP-7002 full-exit request attempts. It does not expose arbitrary external calls for future staking operations, consolidation requests, credential changes, or `0x01 -> 0x02` migration paths.

Future Ethereum staking features may require contract changes or may simply be unsupported by this pool.
