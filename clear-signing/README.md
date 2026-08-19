# ERC-7730 Clear-Signing Descriptor

`calldata-ValidatorFundingPool.json` is an ERC-7730 clear-signing descriptor for the pool's user-facing functions. Wallets that consult Ledger's clear-signing registry use it to render decoded arguments — the `claimTo` and `refundTo` recipient in particular — instead of a data hash.

## What It Does Not Do

It does not change what `npm run <action>:ledger` shows. `@nomicfoundation/hardhat-ledger` calls `ledgerService.resolveTransaction(txToSign, {}, {})` with an empty resolution config, so it requests no external-plugin, token, or NFT descriptor for any transaction. Every Hardhat calldata path stays blind-signed no matter what is published. This descriptor is for participants who sign the same calls through Ledger Live or another registry-aware wallet.

There is also no descriptor entry for `receive()`. A plain ETH transfer carries no selector, and wallets clear-sign it natively from the transaction itself. That is why `fund.ts` prefers a transfer on the `ledger` network.

`FeeRecipientForwarder` is not covered. Its only write function is `sweep()`, which takes no arguments and moves nothing to a caller-chosen address, so there is nothing a descriptor could clarify or mislabel.

## Deployment Binding

`context.contract.deployments[0].address` is the zero address. No mainnet pool has been deployed, so `deployments/latest.json` does not exist and there is no real address to bind. **Replace it with the deployed pool address before submitting anywhere.** A descriptor bound to the wrong address renders one pool's labels over another pool's calldata, which is strictly worse than blind signing. The zero address is deliberate: a registry lint will reject it, so the file cannot be submitted without the substitution.

Every pool deployment is a distinct contract at a distinct address. A descriptor covers one deployment, not the source code, so each deployment needs its own `deployments` entry.

## Registry Submission

The registry moved to Ethereum Foundation stewardship in May 2026 and now lives at `https://github.com/ethereum/clear-signing-erc7730-registry`. The old `LedgerHQ/clear-signing-erc7730-registry` URL redirects there. Anyone may submit; being the deployer is not required, and inclusion implies no audit or endorsement.

The descriptor targets `specs/erc7730-v2.schema.json`, and `$schema` is the relative path registry files use, so the file drops into a registry checkout unchanged. It does not resolve from this repository.

1. Deploy the pool, then **verify it on Sourcify**. Registry CI checks Sourcify verification and will reject the pull request without it.
2. Replace the placeholder address with the deployed pool address and confirm `chainId`.
3. Fork the registry and copy the file to `registry/validator-funding-pool/calldata-ValidatorFundingPool.json`. One entity directory per pull request.
4. Add the required test file at `registry/validator-funding-pool/testsv2/calldata-ValidatorFundingPool.tests.json`, following `specs/erc7730-tests-v2.schema.json`. It is not written here because it needs the real deployment address and real calldata samples.
5. Lint before opening the pull request:

   ```bash
   pip install erc7730
   erc7730 lint registry/validator-funding-pool/calldata-ValidatorFundingPool.json
   ```

6. Open the pull request. CI re-runs schema validation, checks the signature keys produce valid selectors, confirms Sourcify verification, and flags ABI mismatches. ABI-comparison findings are warnings; schema and selector failures are errors.

Ledger's developer-portal reference pages still describe ERC-7730 v1 and will steer you into constructs that fail current CI — an `excluded` key, bare 4-byte selectors as format keys, and a format named `addressOrName`. None of those exist in v2. Treat `specs/erc7730-v2.schema.json` and `erc7730 lint` as the authority.

## Validation Status

The file validates against `specs/erc7730-v2.schema.json` from the registry, checked with a JSON Schema 2020-12 validator.

The schema does not constrain `path`: it is declared as a plain string. Structural validation therefore proves the format names, `params` keys, `addressName` type values, and signature-key pattern are correct, and proves nothing about whether any path resolves to the argument its label claims. Those were written against the ERC-7730 path rules (`#.` for decoded arguments, `@.` for container values such as `@.value`, `$.` for values inside this document) and against the shape of live registry files. They need eyes, not a linter.

## Field Mappings To Review

These are the judgement calls. A reviewer should check each one against the ABI and the contract.

- **`claimTo` / `refundTo` recipient.** `#.recipient` is the payout address and the only argument in the contract whose corruption redirects funds. Labelled "Proceeds paid to" / "Refund paid to". `params.types` is `["eoa", "wallet", "contract"]` because `_validateRecipient` rejects only the zero address and the pool itself, so any other contract is a legal recipient. Narrowing to `["eoa"]` would be a lie.
- **`requestExit` two amounts.** `#.maxFee` is a cap the caller sets, not a payment; `@.value` is what is actually sent, and anything above the live fee is refunded in the same transaction. Both are labelled to say which is which. Format `amount` is applied to `#.maxFee`, a plain `uint256` denominated in wei rather than the container value — confirm that renders as native currency and not as a bare integer.
- **`openFundingAttempt` parallel arrays.** `#.participants.[]` and `#.fundingTargets.[]` are two separate lists rendered one after the other. Nothing on the device ties the Nth participant to the Nth target; the operator has to pair them by position and count. If the wallet renders long arrays poorly this is close to useless, and the operator should keep verifying against the script output instead. The `.[]` whole-array path form is the least-exercised part of this file: it comes from the ERC-7730 path rules rather than from a registry file, and no registry example consulted here uses it. Check it against a real wallet before relying on it, and drop these two fields rather than ship a mis-rendered list.
- **`commitAndPredeposit` hidden signatures.** The two 96-byte BLS signatures are `visible: "never"` because they cannot be read off a device screen. The pubkey and both deposit-data roots stay visible, since those are what the operator cross-checks against the deposit-data file. Hiding a field means the device does not show it; it is still signed.
- **Empty `fields` on no-argument functions.** `claim()`, `refund()`, `topUpValidator()`, and `closeExpiredFundingAttempt()` take no arguments, so only the intent string is shown. The value is that "Claim pool proceeds to your own address" beats a data hash.
- **`fund()` value.** `@.value` is the funded amount. The credited participant is always `msg.sender`, which the wallet already shows as the sending account, so there is nothing else to render.
