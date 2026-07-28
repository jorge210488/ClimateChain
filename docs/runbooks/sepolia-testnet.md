# Runbook: Ethereum Sepolia (public testnet)

How to deploy the contracts to a public network and run the backend against it.
Every command here was executed against Sepolia on 2026-07-28; the outputs are
what the commands actually printed.

## Why bother, when the local stack passes

The local suites prove the logic. They cannot prove behavior under conditions a
local node does not have: ~12-second blocks instead of instant mining, gas
priced by a real market, a remote RPC that can drop a response mid-flight, and
`CHAIN_CONFIRMATIONS` greater than one. Those are exactly the conditions the
submission path is written for, so they have to be observed at least once.

Run a **single policy** through its lifecycle. Do not run the chain e2e suite
here: its policies lock roughly 1 ETH of coverage in total, which is weeks of
faucet drips, and it would re-verify logic the local run already covers.

## What it costs

Measured, not estimated:

| Step | Gas cost |
| --- | --- |
| Deploy `MockWeatherOracle` | 0.00075 ETH |
| Deploy `InsuranceProvider` + link oracle + fund reserve | 0.0040 ETH |
| One policy through creation, trigger, and payout | ~0.005 ETH |

**About 0.15 ETH is comfortable**; 0.05 is enough for one full pass with a
small reserve. The Google Cloud faucet gives 0.05/day, and pk910's proof-of-work
faucet has no prerequisites.

## 1. Credentials

Use a **wallet created for this and nothing else**. The key lands in a file in
plain text; it must never be one that could hold real value.

In `contracts/.env`:

```
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<key>
PRIVATE_KEY=0x<64 hex characters>
ETHERSCAN_API_KEY=<optional, for source verification>
```

The `0x` prefix is required — Hardhat and ethers both reject a bare 64-character
key. A 42-character value is an *address*, not a key.

## 2. Deploy the oracle

`deploy.ts` deploys a mock oracle on local networks and requires
`EXTERNAL_WEATHER_ORACLE_ADDRESS` everywhere else. Until Stage 10 wires a real
Chainlink oracle there is nothing to point that at, so deploy the mock:

```bash
cd contracts
npm run oracle:deploy:sepolia
```

The script refuses to run on any chain id where value is at stake — its weather
data is owner-supplied and must never back real coverage.

Put the address it prints into `contracts/.env`:

```
EXTERNAL_WEATHER_ORACLE_ADDRESS=0x159FC1f21074ef82901335500b574a23a50bfb07
```

## 3. Deploy the provider and wire it up

```bash
npm run deploy:sepolia
npm run oracle:link:sepolia
COVERAGE_RESERVE_ETH=0.03 npm run reserve:fund:sepolia
```

`COVERAGE_RESERVE_ETH` defaults to 10, which is fine locally and unobtainable
from a faucet. Set it explicitly.

Linking is a separate step because the provider's constructor needs the oracle's
address, so the oracle exists first and can only learn the provider's address
afterwards. Skipping it leaves the oracle accepting pushes for any address:
`_assertValidPolicyAddress` checks provenance only once `policyRegistry` is set.

The provider's address is written to `contracts/deployments/sepolia.json`. There
is **nothing to copy into any `.env`** — the backend reads that manifest.

Deployed 2026-07-28:

| Contract | Address |
| --- | --- |
| `InsuranceProvider` | `0xbfc559E62Fb2AE4E0B430a3aDdc3fD7f3AB166ac` |
| `MockWeatherOracle` | `0x159FC1f21074ef82901335500b574a23a50bfb07` |

## 4. Point the backend at it

In `backend/.env`:

```
BLOCKCHAIN_NETWORK=sepolia
CHAIN_ID=11155111
CHAIN_CONFIRMATIONS=2
RPC_URL=<same as contracts>
PRIVATE_KEY=<same as contracts>
```

`CHAIN_CONFIRMATIONS=2`, not 1. A locally mined block is final; a real one can
be reorganized, and one confirmation would let the backend report a policy that
later ceases to exist.

Boot verification prints what it checked against the node itself:

```
Chain verified: chainId=11155111 block=11365694
  provider=0xbfc559E62Fb2AE4E0B430a3aDdc3fD7f3AB166ac (16311 bytes)
  oracle=0x159FC1f21074ef82901335500b574a23a50bfb07
  signer=0x6e612A4ff0dAa0e42423c89303dcb6D8e0378187
  coverageReserveWei=30000000000000000
```

A mismatch stops the process rather than serving traffic against the wrong
chain — including the easy mistake of Base Sepolia (chain id 84532), whose name
invites confusion with Ethereum Sepolia (11155111).

## 5. Observed behavior

One policy, end to end, through the API and then the contracts:

| Step | Wall clock |
| --- | --- |
| `POST /policies` (mined and confirmed) | 24.0 s |
| Idempotent replay of the same key | 24 ms |
| `GET /policies/:address` | 661 ms |
| Weather request | 4.9 s |
| Oracle publishes rainfall | 9.9 s |
| Payout execution | 11.1 s |

Notes worth keeping:

- **24 seconds for creation is correct, not slow.** Two confirmations at ~12s
  blocks is 24 seconds of physics. Any synchronous client needs a timeout above
  it, and a queue is the better shape once traffic is real.
- **The replay costs 24 milliseconds** because it never reaches the chain. The
  gap between 24 s and 24 ms is the entire value of the idempotency record.
- **The weather window opens on a delay.** Policy creation applies a start
  lead-time, so `requestPolicyWeatherData` reverts for the first few minutes of
  a policy's life. On a local chain you skip this by mining forward; here you
  wait. It is not a failure.
- Reads take well under a second even though each fans out into several RPC
  calls, because they are all pinned to one block.

Final state, read back through the API:

```
status=paid_out  settlementType=payout  latestRainfallMm=120
conditionMet=true  pendingPayoutWei=0
```

Coverage of 0.01 ETH reached the insured and the reserve went from 0.03 to 0.02.
