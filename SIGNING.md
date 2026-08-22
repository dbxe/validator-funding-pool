# Signing And Key Custody

How you hold the key that signs a command matters as much as what the command does. This document covers the three custody options, how the Ledger path is wired, what a hardware wallet can and cannot show you before you approve, and the one contract argument the Hardhat Ledger path never renders on the device.

Ranked, for mainnet:

1. **Ledger.** The signing key never reaches this machine. Use the `:ledger` commands.
2. **Encrypted keystore.** The key lives on this machine but never in a shell history, an env file, or a process listing.
3. **`PRIVATE_KEY` in the environment.** Development and test networks only. It is plaintext in your shell, your `.env`, and every child process.

## Ledger

The hardware path is a separate `npm run` entry per action, plus one environment variable. The details below cover why the entries are separate, how the plugin finds your account, and the cached file that must be deleted when the device changes.

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

The plugin locates `LEDGER_ADDRESS` by walking `m/44'/60'/<index>'/0/0` for indices `0` through `20` and asking the device for each address. That walk happens **only for an address the plugin has not seen before**. On success it writes the address-to-path mapping to a cache file and, on every later run, returns the cached path for that address without asking the device to derive anything (`@nomicfoundation/hardhat-ledger/dist/src/internal/handler.js`, `#derivePath`, lines 190-192).

So the first command against a new address is slow, later ones are not, and the device must stay unlocked throughout either way. An account on a different derivation scheme, such as the legacy `m/44'/60'/0'/<index>`, is not found; set `ledgerOptions.derivationFunction` on the `ledger` network for that case.

The cache is a persistent file outside this repository, at `<hardhat config dir>/ledger/accounts.json` (`internal/cache.js`); the config directory is `env-paths("hardhat").config`, which is `~/Library/Preferences/hardhat-nodejs` on macOS, `${XDG_CONFIG_HOME:-~/.config}/hardhat-nodejs` on Linux, and `%APPDATA%\hardhat-nodejs\Config` on Windows.

**Delete that file whenever the connected device or the seed on it changes.** A cached path is trusted, not re-verified: if a different device or a restored-from-different-seed device is plugged in, the plugin asks it to sign at the cached path, that path holds a different key on the new seed, and nothing in the plugin notices. The transaction is signed by an account you did not intend.

Every transacting script therefore checks the mined `receipt.from` against the address it signed for and fails loudly on a mismatch (`waitForSenderVerifiedReceipt` in `scripts/lib/common.ts`) — but that is after-the-fact detection of a transaction already on chain, not prevention. Clearing the cache is the prevention.

The `ledger` network configures no `accounts`, so no private key is read for it. `LEDGER_ADDRESS` is a public address, not a secret, and is read from the environment rather than the keystore; the `ledger` network refuses to load without it.

`eth_accounts` on the `ledger` network returns the node's accounts followed by the Ledger account (`@nomicfoundation/hardhat-ledger/dist/src/internal/hook-handlers/network.js`, lines 47-63). Every script signs with the first. Point `RPC_URL` at a node that exposes no unlocked accounts — any public provider, or your own node with the `personal`/`accounts` namespace disabled. Every transacting script also asserts before signing that the account it is about to use equals `LEDGER_ADDRESS` whenever the connection routes signing through a device, and prints the active signer address on every network (`assertActiveSigner` in `scripts/lib/common.ts`), so a node account slipping into first place aborts the run instead of silently signing.

## Encrypted Keystore

If you are not using a hardware wallet, the keystore keeps the key off your shell history and out of `.env`. The one thing to know is that the environment beats the keystore, silently.

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

## What The Device Actually Shows

Before approving anything on a Ledger, know how much of the transaction the screen is actually telling you. The table below is per command; the short answer is that funding is the only clear-signed action and deployments are the weakest.

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

Fees are filled in by hardhat from whatever the connected endpoint answers — `eth_feeHistory` for the two EIP-1559 fields, `eth_estimateGas` for the gas limit — and nothing in this repository picks or bounds them. On the device that is fine: a Ledger renders the fee on every screen above, so an endpoint that suggested an absurd priority fee is showing it to a person before the signature. Off the device there is no such gate, so every command that transacts prints the fields first:

```
fund fees, as this endpoint suggests them and hardhat will fill them:
  base fee per gas:         8000000000 wei (8 gwei)
  max priority fee per gas: 1500000000 wei (1.5 gwei)
  max fee per gas:          10125000000 wei (10.125 gwei)
  gas limit:                filled from eth_estimateGas when the transaction is composed, so it is not previewed here
```

It is a preview, computed with hardhat's own arithmetic so the max fee is the number the device will show — compare the two. Hardhat re-reads when it composes the transaction, so the signed values may differ by a block's worth of base fee. There is no ceiling and nothing is refused: an endpoint willing to inflate your fees is an endpoint [`SECURITY.md`](SECURITY.md) §2 already tells you not to use.

The `request-exit` value deserves the extra words in the table. `MAX_FEE_WEI` is a ceiling the caller sets, not a payment: `requestExit(uint256)` reads the live EIP-7002 fee, reverts if it exceeds the cap, forwards exactly the live fee to the predeploy, and refunds the difference to the caller in the same transaction (`ValidatorFundingPool.requestExit`).

The device shows what is sent, which is the ceiling. It defaults to twice the fee the script just read, so expect the device to show roughly double the fee you were quoted. What comes back is `MAX_FEE_WEI` minus whatever the fee is at the moment of inclusion: if the fee has not moved, that is half; if it rose in between, less; if it rose above the cap, the request reverts `ExitFeeTooHigh` and nothing is charged.

The two deployment rows are the weakest position on this list. A creation transaction gives the device nothing checkable: no destination, no decodable arguments, just a bytecode blob. You cannot verify a deployment on the device, so verify it after.

Before publishing the pool address to anyone, independently confirm that the deployed runtime bytecode and the immutables baked into it match the build you intended — read `depositContract`, `withdrawalRequestPredeploy`, `operator`, `fundingWindowDuration`, and `withdrawalCredentials` back from the chain, compare the runtime code hash against a local build, and verify the source on Sourcify (`clear-signing/README.md` requires Sourcify verification anyway for registry submission). `npm run deploy` writes all five immutables into the deployment record, and every later script re-reads them from the live pool and refuses on a mismatch. That comparison only detects a deployment record that drifted from the pool, not a pool that was wrong from the first block — which is why every script also derives the withdrawal credentials from the pool's own address and compares the pool's runtime code against your local build. The bytecode comparison is automatic now; Sourcify verification and the repository's own provenance are still yours to check.

## The `claimTo` And `refundTo` Wart

One argument in this contract decides where your money goes, and it is the one argument the Hardhat Ledger path will not render on the device. This section is why, and the ladder of mitigations in the order you should reach for them.

`claimTo(address)` and `refundTo(address)` take the payout address as an ABI argument, not as the transaction destination. On a blind-signed transaction the device shows the destination as the pool and the value as `0`. The address that will actually receive every wei you are owed sits inside calldata the device does not render. A host that has been tampered with can substitute a recipient and the device gives you nothing to compare against. It is the same exposure as any blind-signed argument, but it is the one argument in this contract whose corruption redirects funds outright.

Mitigations, in order:

1. Prefer the no-argument variants. `claim()` and `refund()` both exist and always pay `msg.sender`, which is the device's own account. There is no unverifiable address to corrupt. `claim.ts` and `refund.ts` use them whenever `RECIPIENT` is unset or equals the signing account, so leaving `RECIPIENT` unset is the safe default.
2. Reach for `claimTo` / `refundTo` only when the signing account genuinely cannot receive ETH.
3. When you must redirect, derive the recipient independently on a second machine and compare it against the address the script prints before you approve on the device. `claim` and `refund` print it *before* they compose the transaction — `claim pool: <address>`, `claim recipient: <address>`, `claim amount: <wei>`, followed on the redirected path by a multi-line notice saying in as many words that this address rides in calldata the device will not render and must be compared now. This detects a tampered env file; it does not detect a tampered signing host, which composed that printed line too.
4. Read the confirmation after mining. `assertPayoutReachedRecipient` decodes the pool's own `Claimed` / `Refunded` event out of the receipt — `recipient` is an indexed topic on both — and the command fails, naming the intended address and the actual one, if they differ. It is the same detection-not-prevention shape as the funding credit check: the ETH has already moved, and what it converts is a silent redirection into a named failure.
5. An ERC-7730 descriptor (see below) lets wallets that support it render the recipient. It does not help the Hardhat Ledger path, which requests no descriptor resolution.

## ERC-7730 Clear-Signing Descriptor

The repository ships a descriptor that can make registry-aware wallets render those arguments. It changes nothing about the `npm run *:ledger` commands.

`clear-signing/` holds an ERC-7730 descriptor for the pool's user-facing functions. Submitting it to Ledger's registry is what makes wallets that consult the registry render arguments — the `claimTo` recipient in particular — instead of a data hash.

It does not change what `npm run *:ledger` shows. `@nomicfoundation/hardhat-ledger` calls `ledgerService.resolveTransaction(tx, {}, {})` with an empty resolution config, so it requests no external-plugin, token, or NFT descriptor for any transaction. Hardhat calldata paths stay blind-signed regardless of what is published. The descriptor is for participants who sign the same calls through Ledger Live or another registry-aware wallet.

See `clear-signing/README.md` for the deployment binding and registry submission steps.
