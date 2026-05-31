# Validator Funding Pool

Minimal `0x01` withdrawal-credential funding pool for a fixed group of known funders pooling into one validator.

This is not a liquid staking protocol. It mints no ERC-20, ERC-721, ERC-1155, vault share, receipt token, or transferable claim. Economic rights are internal accounting only.

## Model

- Participants are fixed at deployment.
- Each participant has a fixed funding cap.
- Funding caps are also the post-stake economic weights.
- Before staking, participants can fund or, after the deadline, cancel and refund exact contributions.
- Staking one validator happens only after exact full funding.
- The pool computes withdrawal credentials as `0x01 || 11 zero bytes || address(pool)`.
- After all configured validator deposits are submitted, every ETH balance in the pool is pool proceeds.
- Pool proceeds are claimable pro rata by participant funding weight.
- No contract-level operator premium exists.
- Operator compensation, if any, is external to the pool through validator fee recipient / MEV recipient configuration.
- Any participant can request a full validator exit through EIP-7002 by calling the pool.
- The pool exposes no arbitrary external-call, upgrade, owner rescue, or consolidation-request function.

## Trust Assumptions

- The operator is trusted to provide valid BLS deposit data for the validator.
- The operator is trusted to run the validator correctly and avoid slashable behavior.
- The operator is trusted to configure EL fee recipient / MEV recipient as agreed off-chain.
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
- If a participant cannot receive ETH, their claim reverts and accounting rolls back.

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

The deploy script prints the pool-owned withdrawal credentials. Generate one validator deposit data entry with those credentials, place it at `deposit-data.json` or set `DEPOSIT_DATA_FILE`, then run:

```bash
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run fund
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run stake
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run claim
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run sweep-canceled-surplus
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run request-exit
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... npm run status
```

Useful deployment variables:

- `DEPOSIT_CONTRACT`: deposit contract address.
- `WITHDRAWAL_REQUEST_PREDEPLOY`: EIP-7002 predeploy address.
- `VALIDATOR_DEPOSIT_GWEI`: validator deposit size; defaults to the deposit data amount, then `32000000000`.
- `FUNDING_DEADLINE_SECONDS`: funding window from deployment; defaults to `86400`.
- `PARTICIPANTS`: comma-separated participant addresses; defaults to the deployer.
- `FUNDING_TARGETS_GWEI`: comma-separated funding caps matching `PARTICIPANTS`.

## License

MIT
