# Commands And Environment Variables

Reference for running the repository's commands: how to install and test, what the defaults are, how the optional EL-rewards forwarder is operated, what a failed command prints, and every environment variable the scripts read.

## Installing And Testing

Install dependencies and run the local checks:

```bash
npm ci
npm run build
npm test
```

`npm ci`, not `npm install`: it installs exactly the tree `package-lock.json` names and fails if the lockfile and `package.json` disagree, where `npm install` is free to resolve a newer version and rewrite the lockfile underneath you. What runs the capital paths, verifies the pool's runtime code, and computes deposit data should be the exact tree the release was reviewed and tested with, not whatever resolved today. Use `npm install` only when a dependency update is the change you intend to make, and commit the resulting lockfile as part of it.

### End-To-End Command Tests

The unit suite tests the pieces; a second suite runs the commands themselves as real processes.

`npm test` covers the contract and the helpers the commands are built from. The commands themselves — the order in which a script calls those helpers, which branch it takes, and the lines it prints — are covered separately:

```bash
npm run test:e2e
```

It takes about forty seconds and needs nothing but this checkout. Each case runs a command exactly as `package.json` runs it — the non-`:ledger` form, since the `:ledger` entries differ only by naming a network that needs a device — as a real child process with a controlled environment, against a local `hardhat node` and a deterministic mock beacon node that the harness starts and tears down itself.

The local chain carries the real mainnet deposit contract and the real EIP-7002 predeploy at their real mainnet addresses, and refuses to start unless each hashes to the expectation its own `test-e2e/fixtures/*.json` records — derived from the upstream artifact rather than imported from the pin, so the harness states independently what it is running. `npm test` closes the loop: `test/CanonicalSystemContracts.ts` requires those fixture expectations, the literals the command tests hold the deployment record to, and `CANONICAL_SYSTEM_CONTRACTS` in `scripts/lib/common.ts` to be the same values, so a copy that drifts fails the unit suite instead of leaving a harness that proves nothing.

It is kept out of `npm test` on purpose, so the unit suite stays fast enough to run constantly. Run both before proposing a change to anything in `scripts/`.

`SECURITY.md` §5 lists what the harness covers and the three paths it does not: the Ledger hardware paths, the true mid-flight top-up race, and a forwarder actually receiving a proposal's rewards on a live validator.

## Defaults

What the scripts assume when you set nothing.

- Ethereum deposit contract: `0x00000000219ab540356cBB839Cbe05303d7705Fa`
- EIP-7002 withdrawal request predeploy: `0x00000961Ef480Eb55e80D19ad83579A64c007002`
- Deposit data file: `deposit-data.json`
- Deployment record: `deployments/latest.json`

Override any address or path with environment variables when using an unrecognized test chain. The contract itself checks that configured system addresses have code but does not hardcode mainnet-only addresses; the operational scripts enforce the chain-specific mainnet pins and warn rather than applying them to unknown chain IDs.

## The EL Rewards Forwarder In Operation

What the `FeeRecipientForwarder` sidecar *is* — and why pooling EL rewards is a group decision at all — is in [`README.md`](README.md), "Optional EL Rewards Forwarder". This section is the operational side: deploying it, what is verified and what refuses versus warns, when to point `fee_recipient` at it, and what a sweep proves afterwards.

Deploy it against the pool recorded in the deployment file with `npm run deploy-forwarder`. The script verifies the pool deployment, deploys the sidecar, verifies the forwarder's immutable destination, verifies the deployed forwarder's runtime code against your own build of `contracts/FeeRecipientForwarder.sol`, and adds the optional `feeRecipientForwarder` address to the record. Existing deployment records without that field remain valid.

That last check is the one that matters most for a sidecar. `pool()` returning the right pool is what the deployed code *chooses* to report, so a contract that answers correctly and forwards the balance somewhere else would pass a binding check; the code comparison is what rules that out. The two commands that transact with the forwarder run it as a gate — `sweep` and `deploy-forwarder`, both of which refuse on a failure — and it masks only the two 32-byte ranges the single `pool` immutable occupies.

`status` runs the identical check, but after it has printed every line of pool state, and reports a failure as a loud warning rather than a refusal: it signs nothing, so refusing would only withhold the reconciliation an operator ran it for, and every FATAL in this repository ends by telling them to run it. The other commands skip the forwarder entirely: they never read it, and a sidecar for optional rewards must not be able to stop `refund`, `claim`, or `request-exit`.

Set `EXPECTED_FORWARDER` to pin the recorded address the way `EXPECTED_POOL` pins the pool; that pin *is* evaluated everywhere a record is read, because it costs a string comparison and depends on nothing. In `status` alone it is evaluated *inside* the same warning boundary, alongside the balance read and the authenticity check — checked and reported loudly on a mismatch, never skipped, but never fatal either, because the command that every FATAL tells you to run must print the pool state whatever is wrong with the sidecar or the declaration about it.

Only after the pool is topped up, configure the validator client's `fee_recipient` to the recorded forwarder address. Validator-client configuration syntax varies by client. Do not point `fee_recipient` at the forwarder before top-up: although the forwarder always accepts ETH, `sweep()` cannot deliver it while the pool rejects ordinary ETH, and there is no rescue path if the pool never reaches `ToppedUp`.

Anyone can run `npm run sweep`. It transfers the forwarder's entire balance to the immutable pool, where the ETH becomes pool proceeds distributed pro rata by final credited weight. A zero-balance sweep reverts, and a sweep rejected by the pool remains permissionlessly retryable. `status` displays the configured forwarder's pending balance and verifies it, warning loudly instead of refusing when the verification fails.

After the receipt, `sweep` proves the ETH landed: it requires the receipt's own `Swept` log to be there for this signer, and the pool's balance across the sweep's own block to have risen by at least what the forwarder was holding.

That balance delta is reconciled against the pool's own logs for the same block first — a `claim()` or a `refund()` mined alongside the sweep is ordinary, and its payout comes off the same delta, so the pool's `Claimed`, `Refunded`, and top-up events are added back before the comparison and the pass says what was netted. A rise *above* what the forwarder held is reported rather than refused — the forwarder is a fee recipient, so a proposal can pay into it between the balance read and the sweep. A shortfall that survives the reconciliation is fatal and tells you to reconcile with `npm run status` before re-running. Like the funding credit check, this is detection and not prevention: the ETH has already left the forwarder by the time it runs.

Pooling EL rewards changes the group's economics and must be an explicit group decision. The sidecar makes pooling possible and verifiable when it is configured, but it does not make MEV trustless or enforce the configuration. The operator still controls `fee_recipient` and can change or unset it at any time. The operator is also responsible for confirming contract-recipient behavior with the actual relay and builder set.

## What A Failure Prints

Every failure is a short block on stderr, with one variable that gives you everything behind it.

Every command that fails exits `1` and prints a short block on stderr: a header naming the command, then the walked cause chain's messages with the decoded contract error — `FundingStillOpen()`, `FundingCapExceeded()` — on the line directly under the header. A check this repository makes itself prints its whole message, because the message is the instruction.

The complete error object, with the contract ABI, every stack frame, and the raw cause chain, is one variable away:

```bash
DEBUG=1 npm run fund
```

Reach for it when the summary is not enough. Nothing is filtered out of the summary that changes what happened — only how much of it you have to read to see it.

## Environment Variables

Two rules first, then the variables themselves, in two classes.

Every numeric one — amounts, fees, windows, targets — must be a plain unsigned decimal integer: no `0x` prefix, no sign, no leading zeros, no separators, no surrounding whitespace. `0x20` is a parse error naming the variable, not thirty-two.

Use `https://` for `RPC_URL` and `BEACON_NODE_URL` unless the node is on loopback. Over plaintext `http://` to any other host, everything a dishonest endpoint could do — described in [`SECURITY.md`](SECURITY.md) §2 — is available to anyone on the network path instead. Every command prints a loud warning when either URL is plaintext to a non-loopback host; it is a warning rather than a refusal because a LAN node over plain HTTP is a legitimate setup, and loopback is never warned about. The RPC URL it checks is the connection's own resolved endpoint, so an `RPC_URL` kept in the encrypted keystore — where it never reaches `process.env` — is checked exactly like an exported one.

They divide into two classes, and the class matters more than any individual entry.

### Deploy-Time Variables

Four variables are read by `npm run deploy` and by nothing else. Each becomes an `immutable` in the pool's constructor, so what `deploy` was given is what the pool has for the rest of its life; a later command that sets one is not changing anything, and the only way to change one is to deploy a new pool — which strands the first pool's 1 ETH predeposit. Every other command reads these values back *from the pool* and refuses if the deployment record disagrees.

- `DEPOSIT_CONTRACT`: deposit contract address. Defaults to mainnet's.
- `WITHDRAWAL_REQUEST_PREDEPLOY`: EIP-7002 predeploy address. Defaults to mainnet's.
- `OPERATOR`: operator address; defaults to the deployer.
- `FUNDING_WINDOW_SECONDS`: **required** by `npm run deploy`. The funding window, in seconds, baked into the pool at deploy time and immutable thereafter. It is **not** per attempt: `openFundingAttempt` takes no duration, and every attempt this pool ever opens gets a deadline of `block.timestamp + fundingWindowDuration`. Choose it at deployment as a security decision — a short window bounds how long a listed participant who never funds can lock everyone else's capital ([`SECURITY.md`](SECURITY.md) §2, "Participants"). Unset or empty is fatal naming the variable, before any RPC read; there is no default, because the one it used to have (`86400`) was a permanent choice nobody made, and the error quotes it as the explicit form to type.

  It is bounded to `3600`..`31536000` — one hour to one year. Below an hour an attempt expires before the listed participants could read the funding review and approve on a device; above a year it bounds nothing, and further up it stops being a bad window and becomes a brick, since the deadline is checked arithmetic and a window near the uint256 maximum makes every attempt revert on overflow forever, on a pool whose 1 ETH predeposit is already stranded. The contract accepts anything but zero and `contracts/` is frozen, so the bounds live in the command. `deploy` prints `Funding window (immutable): <n>s` before deploying, `status` prints it read back from the pool, and setting the variable in `open-funding-attempt`'s environment is a fatal error rather than a silent no-op — that command prints the pool's actual window next to the deadline it sets.

### Per-Command Variables

- `RPC_URL`: execution-layer JSON-RPC endpoint used by every command.
- `DEPLOYMENT_FILE`: path to the deployment record; defaults to `deployments/latest.json`. This selects the *subject* of every check a command makes, not merely where a file lives: the record names the pool, and the chain-id comparison, the five immutables, both system-contract code hashes, the canonicity pin, the forwarder binding, and the address capital is sent to are all read from — or compared against — the record this variable chooses. `deploy` writes it; every other command reads it. Every command prints the resolved path in its opening lines, next to the active-signer line, so which record a run acted on is never a guess.
- `DEPOSIT_DATA_FILE`: path to the deposit-data file; defaults to `deposit-data.json`. It selects the pubkey, signatures, and deposit-data roots that `commit-predeposit` commits, that `fund` compares against the on-chain commitment before sending, and that `top-up` and `request-exit` cross-check the committed pubkey against. `request-exit` is the one command that only *warns* when the file is unreadable and proceeds on the RPC's value, because the recovery path must not be disableable by a missing file.

  Like `DEPLOYMENT_FILE` it selects the *subject* of the checks rather than waiving one — the record chooses which pool, this chooses which validator — so each of those four commands prints `Deposit data file: <path>` before it opens the file, and which file a run acted on is never a guess. `request-exit`'s read is the try-guarded one: it announces the path the same way and warns rather than failing when the file is unreadable.
- `EXPECTED_POOL`: optional declared pool address. Set it and every command that reads a record requires the record's `pool` to equal it, case-insensitively, before any other check runs; `fund` re-checks it in the final on-chain re-read immediately before signing. `deploy` reads no record — it writes one — and treats a declaration as a redeploy guard instead: a fresh deployment can never be the pool you already named, so it refuses before writing the record rather than overwriting the record that declaration was about.

  This is the pin for `DEPLOYMENT_FILE`: a record for a different pool — stale, swapped, or simply the wrong path in the environment — otherwise passes every check in the list above while describing a pool you did not mean. An unparseable value is fatal naming the variable, never ignored.
- `EXPECTED_FORWARDER`: optional declared fee-recipient forwarder address. `DEPLOYMENT_FILE` names the forwarder as freely as it names the pool, and the forwarder is what a validator client pays every proposal's execution-layer rewards to. Set it and every command that reads a record requires the record's forwarder to equal it, case-insensitively — including a record that names no forwarder at all, which is fatal rather than a silent pass, because that is the pre-`deploy-forwarder` record and pointing at it is the mistake the pin exists to catch. `status` is the one exception to *fatal*, not to *checked*: it evaluates the same pin, in the same two cases, and prints the same finding as a loud warning after all the pool state, exit code unchanged.

  `deploy-forwarder` writes that field rather than reading it, and treats a declaration as a redeploy guard, exactly as `deploy` treats `EXPECTED_POOL`: a declaration names a forwarder that already exists and a fresh deployment can never be it, so the command refuses while the variable is set at all — before a single request, so nothing is left deployed and unrecorded. If replacing the forwarder is what you meant, unset it, and remember that the validator client's `fee_recipient` still points at the old address until you change that too. An unparseable value is fatal naming the variable.
- `EXPECTED_CHAIN_ID`: optional declared chain id. **Set it to `1` for mainnet.** It becomes hardhat's own `chainId` field on the `rpc`, `read`, and `ledger` networks, which installs a chain-id validator ahead of every request handler on the connection: the first request that is not `eth_chainId` or `net_version` fails with `HHE708` naming both ids if the endpoint is not on the declared chain, before anything is composed or signed, on every command including the `:ledger` ones. Those two are the requests the validator answers *with*, which is why it skips them; every command makes some other request within its first few, so the pin still fires ahead of anything being composed.

  Unset, the field is absent entirely and nothing changes, which is what keeps devnet and testnet runs working. A value that is not a plain positive decimal is fatal when the config loads, naming the variable — as is one above `Number.MAX_SAFE_INTEGER`, since hardhat's `chainId` field is a `number` and a larger declaration would otherwise be rounded and pinned as a chain id nobody declared. It closes chain confusion and a misdirected `RPC_URL`; it does not close a dishonest endpoint that answers the validator's request and the signing request differently — see [`SECURITY.md`](SECURITY.md) §5 for the measurement.
- `LEDGER_ADDRESS`: Ledger account address for the `ledger` network; required by every `:ledger` command.
- `EXPECTED_SIGNER`: optional declared signing address. Every command prints the account it is about to sign with; set this and the command additionally refuses to sign with anything else, on any network including `ledger`. It is the check that catches a forgotten `PRIVATE_KEY` in the environment outranking a keystore entry.
- `FUND_VIA_TRANSFER`: `1` forces `fund` to send a zero-calldata transfer, `0` forces the `fund()` calldata path. Defaults to the transfer path on the `ledger` network and to calldata elsewhere. It waives no check — every preflight, every `EXPECTED_*` pin, the final on-chain re-read, and the receipt-log credit confirmation run identically on both routes — but `=1` selects the route with no contract revert underneath it: `fund()` calldata reverts `InvalidState` on a pool that has already topped up, while a plain transfer in that state is accepted by `receive()` as pool proceeds, credited to nobody (see [`ACCOUNTING.md`](ACCOUNTING.md), "Plain-Transfer Funding — The One Divergence"). Decide it per run, against the pool state you just read, rather than exporting it once in a shell profile: the value that was right for one run is the donation case in the next.
- `PARTICIPANTS`: **required** by `open-funding-attempt`. Comma-separated addresses; must include the operator. Unset or empty is a fatal error naming the variable, before any RPC read — there is no default, because the one it used to have (the operator alone, at the full 32 ETH) is indistinguishable on chain from an attempt that was meant that way. A deliberate single-participant attempt is written out: `PARTICIPANTS=<operator address> FUNDING_TARGETS_GWEI=32000000000`.
- `FUNDING_TARGETS_GWEI`: **required** by `open-funding-attempt`. Comma-separated final economic weights, positionally matching `PARTICIPANTS` and summing to `32000000000`. Unset or empty is fatal naming the variable, for the same reason and with the same single-participant form spelled out; a length mismatch against `PARTICIPANTS` is fatal too, since target *i* belongs to participant *i* and a mismatch has no reading.
- `AMOUNT_WEI`: optional partial funding amount for `fund`; defaults to the caller's entire remaining allocation, may not exceed it, and may not be zero — the pool reverts a zero-value fund, so `fund` refuses it rather than composing a transaction that cannot succeed.
- `EXPECTED_PUBKEY`: optional declared validator pubkey for `commit-predeposit`. This is the pin for `DEPOSIT_DATA_FILE`, and it is what `EXPECTED_POOL` is for `DEPLOYMENT_FILE`. `fund` and `top-up` need no declaration because they compare the file against a commitment that already exists on chain; `commit-predeposit` *creates* that commitment, so nothing on chain can check it and the pubkey the file names becomes this pool's validator permanently.

  Set it and the command requires the file's 1 ETH predeposit entry to name exactly that pubkey, before any RPC read; a value that is not 48 bytes of hex is fatal naming the variable. Leave it unset and the command prints the pubkey it is about to commit and warns loudly that nothing independent of the file has checked it.
- `EXPECTED_FUNDING_ATTEMPT`: optional `fund` check for the active attempt number.
- `EXPECTED_MY_TARGET_GWEI`: optional `fund` check for the caller's current-attempt target.
- `EXPECTED_OPERATOR_TARGET_GWEI`: optional `fund` check for the operator's current-attempt target.
- `EXPECTED_DEADLINE_BEFORE`: optional `fund` check requiring the funding deadline to be at or before this Unix timestamp.
- `DEPOSIT_NETWORK_NAME`: optional deposit-file metadata check.
- `RECIPIENT`: optional nonzero, non-pool recipient for `claim` and `refund`. Unset, both commands call the no-argument `claim()` / `refund()`, which pay `msg.sender` and put no address in calldata at all. Set, they call `claimTo(address)` / `refundTo(address)`, and that address is an ABI argument no hardware wallet renders — so both commands print the pool, the recipient, and the amount before composing the transaction, with a loud notice on the redirected path, and both re-check the recipient against the pool's own `Claimed` / `Refunded` event in the mined receipt. See [`SIGNING.md`](SIGNING.md), "The `claimTo` And `refundTo` Wart".
- `MAX_FEE_WEI`: optional cap on the EIP-7002 exit request fee for `request-exit`, and the value the transaction carries. Defaults to twice the fee read immediately before sending, so an ordinary fee uptick between the read and inclusion does not revert `ExitFeeTooHigh`. Only the live fee is forwarded to the predeploy; the rest is refunded in the same transaction. A value below the currently observed fee is rejected before signing.
- `BEACON_NODE_URL`: beacon REST URL for validator predeposit confirmation, funding and top-up preflights, and the advisory exit preflight; required by `commit-predeposit`, `fund`, and `top-up`.
- `GENESIS_FORK_VERSION`: the beacon-chain genesis fork version, for a chain this repository does not pin. Mainnet's `0x00000000` is pinned in the source and the beacon node is required to report it; on a devnet, set this to that network's value and it is enforced the same way. It cannot overrule a pinned chain — a declaration that disagrees with the pin is fatal, not an override. See [`VERIFICATION.md`](VERIFICATION.md), "Pinning `genesis_fork_version`".
- `REFUND_PARTICIPANTS`: optional comma-separated addresses for `status` to display refund-only claimants that are no longer in the current funding attempt.
