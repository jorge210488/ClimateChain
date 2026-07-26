# Runbook: Local Stack (contracts + backend)

How to bring up a local chain, deploy the contracts to it, and run the backend
against a **reachable** RPC endpoint. Every command here was executed and
verified; the expected output is what the command actually printed.

Applies from Stage 05 onward. The ML service joins in Stage 07.

## Why `localhost` and not `hardhat`

The `hardhat` network is an in-process chain: it exists only for the lifetime of
the command that created it. `contracts/deployments/hardhat.json` therefore
records addresses that no RPC endpoint can serve — useful for tests, useless for
running the backend against.

The `localhost` network targets a standalone node on `http://127.0.0.1:8545`.
Its addresses are real and reachable, which is what the backend's Stage 06 chain
client will need. **Use `localhost` for anything that runs the backend.**

Addresses are deterministic: a fresh node always starts the default deployer at
nonce 0, so redeploying reproduces the committed manifest exactly.

## 1. Start the node

```bash
cd contracts
npx hardhat node
```

Leave it running. Verify from another shell:

```bash
curl -s -X POST http://127.0.0.1:8545 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"0x7a69"}   -> 0x7a69 = 31337
```

## 2. Deploy

```bash
cd contracts
npm run deploy:localhost
npm run reserve:fund:localhost   # required before any policy can be created
```

`fundCoverageReserve` is owner-only and a fresh provider holds nothing, so
without the second command every creation reverts with
`InsufficientCoverageReserve` (the API reports this as HTTP 503 naming the
shortfall). Amount defaults to 10 ETH; override with `COVERAGE_RESERVE_ETH`.

Expected:

```text
Deploying contracts with account: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
MockWeatherOracle deployed at: 0x5FbDB2315678afecb367f032d93F642f64180aa3
InsuranceProvider deployed at: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
[WARN] Coverage reserve is empty. Fund with fundCoverageReserve() before creating policies.
MockWeatherOracle policy registry set to: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
Deployment manifest written to: .../contracts/deployments/localhost.json
```

The coverage-reserve warning is expected on a fresh deploy and is not a failure.
`createPolicy` reverts with `InsufficientCoverageReserve` until the owner funds
the reserve, so fund it before exercising policy creation in Stage 06.

## 3. Confirm the manifest points at live code

The backend validates that the manifest is *well-formed*; it does not yet check
that anything is deployed at those addresses (that check belongs to Stage 06).
Until then, verify manually — an empty result means you are pointing at a node
that never received the deploy:

```bash
curl -s -X POST http://127.0.0.1:8545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512","latest"]}'
```

Expected: a long `0x60806040...` string. Verified sizes on a clean deploy —
`InsuranceProvider` 15037 bytes, `MockWeatherOracle` 2876 bytes.

A bare `"0x"` means no contract at that address: the node was restarted without
redeploying, or the manifest is from a different chain.

## 4. Run the backend against it

```bash
cd backend
```

In `backend/.env`:

```dotenv
NODE_ENV=development
BLOCKCHAIN_NETWORK=localhost
RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
# Hardhat's first default account. Development-only by design; never reuse a
# key that holds real funds. Required for policy creation; reads work without it.
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Give each running instance its own signing account: two instances sharing one
signer collide on transaction nonces.

`CHAIN_ID` is optional but recommended: when set, boot fails if it disagrees
with the manifest, which catches "pointing at the wrong chain" immediately.

```bash
npm run start:dev
```

Verify:

```bash
curl -s http://localhost:3000/health/ready       # 200
curl -s http://localhost:3000/blockchain/deployment
# {"network":"localhost","chainId":"31337",
#  "providerAddress":"0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
#  "oracleAddress":"0x5FbDB2315678afecb367f032d93F642f64180aa3",
#  "loadedContracts":["InsuranceProvider","InsurancePolicy"],
#  "providerAddressSource":"manifest"}
```

Readiness aggregates configuration, on-chain metadata, and live chain
reachability. Without `RPC_URL` it reports **503 with `chain: down`** — accurate,
not broken: the service cannot serve policy traffic without a chain.

Exercise the full path:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/token \
  -H 'content-type: application/json' -d '{"apiKey":"<your ADMIN_API_KEY>"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')

curl -s -X POST http://localhost:3000/policies -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"coverageEth":"1.0","premiumEth":"0.05","rainfallThresholdMm":50,"durationDays":30,"region":"Valencia"}'
# {"address":"0x…","transactionHash":"0x…","status":"active","blockNumber":5,
#  "gasUsed":"1541309","insured":"0x…"}

curl -s http://localhost:3000/policies/<address>
curl -s "http://localhost:3000/policies?offset=0&limit=5"
```

Premium quoting still returns HTTP 501 until Stage 09.

> **The contract assigns the insured from `msg.sender`**, so a policy created
> through this API is beneficiary-bound to the backend's signer, not to an end
> user. The response returns `insured` explicitly so this is visible rather than
> assumed. Changing it needs either an `insured` parameter on the contract or a
> user-signed flow — a domain decision, not a backend fix.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Boot aborts: "Missing deployment manifest ... `localhost.json`" | Never deployed to `localhost` | Step 2 |
| Boot aborts: "Configured CHAIN_ID=… does not match manifest" | `.env` points at a different chain than the manifest | Align `CHAIN_ID` / `BLOCKCHAIN_NETWORK`, or redeploy |
| Boot aborts: "RPC_URL is required for …" | Deployed profile without an endpoint | Set `RPC_URL` (deployed profiles refuse to start without it) |
| Boot aborts: "CORS_ORIGINS is required for …" | Deployed profile without an origin allowlist | Set `CORS_ORIGINS` |
| `eth_getCode` returns `0x` | Node restarted; state is not persisted | Redeploy (step 2) |
| Boot aborts: "No contract code found at 0x…" | Manifest points at a chain where nothing is deployed | Redeploy (step 2) |
| Boot aborts: "The node reports chainId=… but the manifest declares…" | `RPC_URL` points at a different chain | Fix `RPC_URL` or redeploy |
| Boot aborts: "Deployed contract constants do not match POLICY_DOMAIN" | Node runs an older contract build than the backend validates against | Redeploy current contracts |
| `/health/ready` 503 with `chain: down` | No `RPC_URL`, or the node stopped | Start the node, set `RPC_URL` |
| Policy creation returns 503 "coverage reserve" | Reserve empty or too small | `npm run reserve:fund:localhost` |
| Policy creation returns 503 "insufficient balance" | Signer has no ETH for gas | Fund the signing account |
| Policy creation returns 409 "nonce" | Two processes share one signer | Give each instance its own account |
| `/docs` returns 404 | Expected on staging/testnet/production | Set `SWAGGER_ENABLED=true` if docs are genuinely wanted there |

## Teardown

Stop the backend, then the node. Node state is in-memory: stopping it discards
every deployed contract and all policy state. After a restart, redeploy before
using the backend again.

## Related

- Stage gates: `contracts/` → `npm run stage4:check`, `backend/` → `npm run stage5:check`
- Deployment manifest format: `contracts/deployments/README.md`
- Backend configuration reference: `backend/README.md`
