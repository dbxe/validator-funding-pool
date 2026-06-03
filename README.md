# Validator Funding Pool

Minimal `0x01` withdrawal-credential funding pool for a fixed group of known funders pooling into one validator.

This is not a liquid staking protocol. It mints no ERC-20, ERC-721, ERC-1155, vault share, receipt token, or transferable claim. Economic rights are internal accounting only.

## Model

- Participants are fixed at deployment.
- Each participant has a fixed funding cap.
- Funding caps are also the post-stake economic weights.
- The pool starts uninitialized and accepts no ETH until validator data is committed.
- The operator commits one validator pubkey, signature, and deposit data root before funding begins.
- Before staking, participants can fund or, after the commitment-started deadline, cancel and refund exact contributions.
- The operator may stake the committed validator after exact full funding and before the funding deadline.
- The pool computes withdrawal credentials as `0x01 || 11 zero bytes || address(pool)`.
- The validator deposit is exactly `32 ETH`.
- After the validator deposit is submitted, every ETH balance in the pool is pool proceeds.
- Pool proceeds are claimable pro rata by participant funding weight.
- No contract-level operator premium exists.
- Operator compensation is external to the pool through validator fee recipient / MEV recipient configuration.
- Any participant can request a full validator exit through EIP-7002 by calling the pool.
- The pool exposes no arbitrary external-call, upgrade, owner rescue, or consolidation-request function.

## Trust Assumptions

- The operator is trusted to provide valid BLS deposit data for the validator.
- The operator is trusted to run the validator correctly and avoid slashable behavior.
- EL priority fees and MEV are operator-controlled. The default expectation is that the operator keeps them as hardware incentive. If the group wants to split those rewards, the operator can configure the fee recipient / builder payout address to the pool.
- The contract enforces custody of consensus withdrawals and pro-rata pool distribution only.

## Defaults

- Ethereum deposit contract: `0x00000000219ab540356cBB839Cbe05303d7705Fa`
- EIP-7002 withdrawal request predeploy: `0x00000961Ef480Eb55e80D19ad83579A64c007002`
- Deposit data file: `deposit-data.json`
- Deployment record: `deployments/latest.json`

Override any address or path with environment variables when using a test chain.

## Accounting Notes

- Claim timing does not change anyone's cumulative entitlement. Claims move ETH from pool balance to `totalClaimed`, and `grossPoolProceeds()` includes both.
- Integer division can leave tiny rounding dust. At a fixed final gross amount, dust is bounded below the participant count in wei. Later proceeds can make prior dust claimable.
- ETH forced into the pool before staking becomes pool proceeds after staking.
- ETH forced in after cancellation is outside refund accounting, but participants can sweep canceled surplus. If anyone funded, sweep weights are the funded amounts at cancellation; otherwise sweep weights are the deployment funding targets.
- Participants can call `claimTo`, `refundTo`, and `sweepCanceledSurplusTo` to send ETH to a nonzero, non-pool recipient address. The no-argument wrappers send to the participant address.

## Commands

```bash
npm install
npm run build
npm test
```

RPC scripts use `RPC_URL` and `PRIVATE_KEY`:

```bash
RPC_URL=http://localhost:8545 \
PRIVATE_KEY=0x... \
PARTICIPANTS=0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222 \
FUNDING_TARGETS_GWEI=16000000000,16000000000 \
npm run deploy
```

The deploy script prints the pool-owned withdrawal credentials. Generate one validator deposit data entry with those credentials, place it at `deposit-data.json` or set `DEPOSIT_DATA_FILE`, then commit the validator data before anyone funds:

```bash
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run commit-validator
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run fund
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run refund
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run stake
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run claim
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run sweep-canceled-surplus
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run request-exit
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run status
```

Useful deployment variables:

- `DEPOSIT_CONTRACT`: deposit contract address.
- `WITHDRAWAL_REQUEST_PREDEPLOY`: EIP-7002 predeploy address.
- `OPERATOR`: operator address; defaults to the deployer.
- `FUNDING_WINDOW_SECONDS`: funding window from validator commitment; defaults to `86400`.
- `PARTICIPANTS`: comma-separated participant addresses; defaults to the deployer.
- `FUNDING_TARGETS_GWEI`: comma-separated funding caps matching `PARTICIPANTS`; must sum to `32000000000`.
- `EXPECTED_PUBKEY`: optional pubkey check for `commit-validator`.
- `DEPOSIT_NETWORK_NAME` / `DEPOSIT_FORK_VERSION`: optional deposit-file metadata checks.
- `RECIPIENT`: optional nonzero recipient for `claim`, `refund`, and `sweep-canceled-surplus`.
- `BEACON_NODE_URL`: optional beacon REST URL for validator pubkey absence checks before commit/stake and validator status checks before request-exit.

## Operational Flow

1. Deploy the pool with participants, funding targets, operator, and system contract addresses.
2. Read the pool address and withdrawal credentials.
3. Generate deposit data with regular `0x01` withdrawal credentials pointing to the pool address.
4. Run `commit-validator`; it checks the amount, credentials, hex sizes, optional metadata, recomputes the deposit data root, and fails if `BEACON_NODE_URL` shows the pubkey already in beacon state.
5. Participants inspect the committed pubkey, root, signature, and withdrawal credentials, then fund.
6. The operator calls `stake()` after exact `32 ETH` funding; with `BEACON_NODE_URL` set, the script checks the pubkey is still absent before submitting the deposit.
7. Any participant can request an EIP-7002 full exit. Exit requests are attempts; retries are allowed because CL-side processing can ignore an accepted request.

The contract cannot practically verify BLS proof-of-possession or whether the pubkey was previously used. Those checks belong in the operator runbook before funding.

## License

MIT
