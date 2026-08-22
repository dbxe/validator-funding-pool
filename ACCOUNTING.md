# Accounting And Funds Flow

This document covers how the pool accounts for the ETH it holds, what reaches participants and on what terms, and the one sharp edge in the funding path — the narrow window in which a plain transfer can land as proceeds instead of as funding.

## Accounting Model

This section states the rules the contract uses to turn deposited ETH into economic weight, and how entitlement is computed from balance rather than from a running ledger.

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

This section establishes that ETH can arrive at the pool without any pool function running, and that the accounting still picks it up.

The pool uses balance-based accounting, so ETH that reaches the pool is accounted for even if no Solidity function executes. Silent balance increases can come from:

- consensus withdrawals to the pool's `0x01` withdrawal credentials;
- priority-fee / coinbase payments if the validator or builder configuration points to the pool;
- forced ETH transfers, including `selfdestruct`-based transfers.

Ordinary ETH transfers are accepted only during `Funding` and `ToppedUp`. Forced ETH can still arrive in any state.

Forced ETH before top-up becomes pool proceeds after top-up, except that outstanding refund claims remain excluded. There is no sender rescue path for forced ETH.

## Plain-Transfer Funding

This section establishes that funding by plain ETH transfer is equivalent to calling `fund()` in every state but one, and why the transfer path exists at all.

### The Two Paths Are The Same During `Funding`

A participant can fund by sending a plain ETH transfer to the pool instead of calling `fund()`. `receive()` routes a transfer to the same `_fund(msg.sender, msg.value)` used by `fund()`, so during `Funding` the two paths are indistinguishable: same credit, same `ParticipantFunded` event, same `AccountingSnapshot`, same reverts.

Exceeding the caller's remaining allocation reverts `FundingCapExceeded` on both paths; a plain transfer cannot silently over-fund. A non-participant reverts `NotParticipant` on both paths. Before `Funding`, and after an expired attempt is closed, both paths revert `InvalidState`.

### Why The Transfer Path Exists

The transfer path exists because it clear-signs. A zero-calldata transfer renders the destination and the amount on a hardware wallet; `fund()` calldata does not. `fund.ts` uses it by default on the `ledger` network.

### The One Divergence

The paths differ in exactly one state. Once the pool is `ToppedUp`, `fund()` reverts `InvalidState` and returns the ETH, while `receive()` accepts it as pool proceeds and emits `EthReceivedViaCall`. Accepted proceeds are shared pro rata by *final credited weight*, and `receive()` in `ToppedUp` accepts ETH from anyone without checking who sent it.

#### What Comes Back

How much comes back therefore depends on whether the sender is credited in the attempt that topped up:

- **Credited in that attempt.** They recover their own share. At a `12 ETH` weight, a stray `1 ETH` transfer returns `0.375 ETH` through `claim()` and donates the other `0.625 ETH` to the remaining participants.
- **Not credited in that attempt.** They recover nothing. `claimable()` returns `0` for any address whose `creditedWeiOf` is zero, and `claim()` has nothing to pay it. The whole transfer is donated. This is the case for a sender whose transfer sat unmined while their attempt expired and a fresh attempt without them topped up.

#### First Way In: Two Sends In Flight

That window is narrow, and reaching it requires the participant to have sent twice. `topUpValidator()` requires `totalActiveFundedWei` to equal exactly `31 ETH`, which requires every participant's remaining allocation to be zero — including the sender's.

`fund.ts` refuses to send when the caller's remaining allocation is zero, and re-reads state, deadline, and remaining allocation together immediately before signing. So the sender's remaining allocation must go from nonzero at that re-read to zero before the transfer is mined, and only another transaction from that same sender can consume it.

The reachable sequence is therefore: the participant has two funding transactions in flight, the first fills their allocation, the operator's `topUpValidator()` lands, and the second arrives against a topped-up pool. The reverse ordering is safe — a second send that arrives while `Funding` is still open reverts `FundingCapExceeded` and the ETH comes back.

#### Second Way In: A Transfer Stuck Past The Deadline

One other path reaches the same window without a double-send, and it is far narrower — and it is the total-loss one. If a single transfer stays unmined past the funding deadline, someone closes the expired attempt, the operator opens a fresh attempt that the sender is not part of or is fully funded without them, and that attempt tops up — then the stale transfer lands in `ToppedUp` against a pool that credits the sender nothing.

The final re-read requires the deadline to still be in the future, so this needs a transaction to sit pending for the rest of the funding window plus an entire second attempt. Underpriced funding transactions are the way to get there, so price them to confirm.

#### Third Way In: A Stale Or Dishonest RPC

There is a third way in, and it needs neither a double-send nor a stuck transaction. Every state check `fund.ts` makes — including the final re-read — reads the endpoint in `RPC_URL`. An RPC that is stale, forked, or dishonest and reports `Funding` for a pool that is already `ToppedUp` lets a single, first-and-only transfer straight through into the proceeds window.

Nothing local can *prevent* it: the script cannot detect a lie using the same endpoint that is telling it, and unlike `fund()` there is no revert underneath. **The plain-transfer path trusts the EL RPC's freshness.** That is the real cost of the clear-signed device screen, alongside the timing race above. Point `RPC_URL` at an endpoint you control or trust; where you cannot, `FUND_VIA_TRANSFER=0` puts the contract's revert back underneath you.

#### Detection After The Fact

All three modes are *detected* after the fact. `fund.ts` reads the mined receipt's own logs and requires a `ParticipantFunded` event from the pool for the signing account with exactly the amount sent. A receipt that carries `EthReceivedViaCall` instead is fatal and says so: the ETH was accepted as post-top-up proceeds, not credited as funding.

This is detection, not prevention — the transfer is already on chain. What the receipt buys is that it is the transaction's *own* record, from the block that included it, rather than a fresh question about current state: that is what catches a stale read or a race lost in the mempool, and it turns an uncredited transfer into a loud failure and an instruction to reconcile rather than a success line.

It is not independent of the endpoint. `eth_getTransactionReceipt` goes to the same place as every other read, and an endpoint dishonest enough to fake pool state can fake a receipt; the trusted-endpoint assumption in [`SECURITY.md`](SECURITY.md) §2 is load-bearing here too.

#### Operationally

- Never run a funding command twice. Check `npm run status` first.
- If a funding transaction is stuck, replace it at the same nonce. Never send a second transaction at a new nonce.
- The final re-read narrows the window; it cannot close it. No off-chain check can.
- If the receipt check fires, the ETH is already gone. Run `npm run status` and reconcile before sending anything else.
- The final re-read is only as fresh as `RPC_URL`. Use an endpoint you control or trust, over TLS: on plaintext `http://` to a non-loopback host, anyone on the network path has the same capability as a dishonest endpoint. Every command warns when either URL is plaintext.
- If certainty matters more than clear signing, use the calldata path with `FUND_VIA_TRANSFER=0`. A late `fund()` reverts and the ETH stays with the sender. That is the trade: the transfer path buys a readable device screen at the cost of the revert acting as a safety net in this one window.

## Event Reconciliation

This section establishes what the pool's events are for, and what they are not: they help you reconcile, but entitlement is computed from balance.

Events are reconciliation aids, not the source of entitlement accounting.

- `EthReceivedViaCall(sender, amount)` is emitted only when ETH reaches `receive()` after top-up.
- `RefundCredited(attempt, participant, amount, participantTotal, totalRefundableWei)` is emitted when an expired attempt turns active funding into a passive refund claim.
- `AccountingSnapshot(...)` is emitted after selected accounting actions and records the post-action observed state.
- Snapshots are emitted after predeposit, funding-attempt open/close, successful funding, top-up, claims, and refunds, where the contract's accounting state changes.
- Snapshot events include funding attempt, balance, active funding, refund liabilities, refunded totals, final credited weights, claimed totals, and `grossPoolProceeds()`.
- Silent balance increases can occur between snapshots and may not emit any pool event.

Authoritative entitlement accounting remains balance-based. Events are useful for operations, audit trails, and reconciliation, but they are not a complete proceeds ledger or source-of-funds classifier.
