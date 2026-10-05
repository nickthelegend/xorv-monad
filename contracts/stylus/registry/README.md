# XorvRegistry (Arbitrum Stylus, Rust)

The Xorv provider registry and reputation ledger. It implements
[`contracts/src/interfaces/IXorvRegistry.sol`](../../src/interfaces/IXorvRegistry.sol).
`XorvEscrow` (Solidity) calls it through that interface: when the escrow releases or refunds a
job, it calls `recordOutcome` in the same transaction. A provider's track record can only come
from settled payments. Nobody can post it themselves.

## Why Stylus

- **Reputation is the hot path.** Every settled job writes a provider's counters. On Stylus,
  WASM compute and memory cost far less than the EVM equivalent, so the contract logic adds
  little on top of the storage writes it cannot avoid. The record is packed the way Solidity
  would pack it: four `uint64`s in one slot, so four slots per provider. A job success writes
  two slots and a failure writes one. `metadataUri` goes out in an event and is not stored.
- **Solidity and Rust interoperate on Arbitrum.** The escrow is ordinary Solidity and calls
  this contract through a normal Solidity interface. It cannot tell that the registry is WASM.
  `cargo stylus export-abi` produces [`abi.sol`](abi.sol), and its function selectors match
  `IXorvRegistry.sol` one for one.

## Behaviour

| Function | Who | Notes |
|---|---|---|
| `constructor(owner)` / `initialize(owner)` | deployer / anyone, once | Rejects a zero owner (`ZeroAddress`) and a second call (`AlreadyInitialized`). `deploy.sh` uses the constructor, so deploying and initializing happen in one transaction. |
| `register(nodeId, uri)` | provider | `nodeId != 0`, `uri` ≤ 256 bytes. If the provider registers again, `nodeId` is updated, the provider is reactivated and its counters are kept. `providerCount` goes up only on an address's first registration. |
| `registerFor(provider, nodeId, uri)` | operator or owner | Sponsored onboarding, so the provider pays no gas. |
| `deactivate()` | provider | `NotRegistered` / `Inactive`. The provider's history is kept. |
| `heartbeat()` / `heartbeatFor(p)` | provider / operator or owner | The provider must be registered and active. Sets `lastSeen = block.timestamp`. |
| `recordOutcome(p, success, amount)` | escrow only | On success: `completed++` and `earned += amount`. On failure: `failed++`. If `p` has no record, one is created with `active=false` and `nodeId=0`, and it is not counted in `providerCount`. A deactivated provider still accumulates outcomes. Counters saturate instead of overflowing, so reporting an outcome can never block settlement. |
| `score(p)` | view | `(completed+1)*10000/(completed+failed+2)`, computed in `u128`. A provider with no history scores 5000, and the score never reaches 10000. |
| `setEscrow` / `setOperator` | owner | Setting zero turns off outcome reporting or sponsored calls. |
| `transferOwnership(newOwner)` | owner | Rejects zero. |

Errors are Solidity custom errors: `Unauthorized(address)`, `AlreadyInitialized()`,
`NotRegistered(address)`, `ZeroAddress()`, `InvalidNodeId()`, `Inactive(address)`,
`MetadataTooLong(uint256)`. Every event matches the interface. The contract makes no external
calls, holds no funds and has no payable functions, so it has no reentrancy surface.

## ABI notes

- `getProvider` returns the flattened tuple `(bytes32,uint64,uint64,uint64,uint64,uint256,bool)`.
  Every field of `Provider` is static, so this encodes exactly like the struct. Solidity callers
  can decode it as `IXorvRegistry.Provider`.
- Parameter names in `abi.sol` are snake_case, for example `node_id`. Names are not part of the
  ABI. The export does not list events, but the events are emitted with the interface's exact
  signatures, and a unit test checks this.
- The export also leaves out the constructor. Run `cargo stylus constructor` to see it:
  `constructor(address owner)`.

## Test

```sh
cargo test          # 47 unit tests on the SDK's TestVM (stylus-sdk 0.10.9)
cargo clippy --all-targets
```

The tests cover:
- one-time initialization, both through `initialize` and through the constructor
- first registration, re-registration and reactivation
- `Unauthorized` for every restricted function and every wrong caller
- `recordOutcome` from anyone other than the escrow, and with the escrow unset
- counter and earnings accounting, including saturation at `U256::MAX`
- the score formula, including its `u64::MAX` extremes, plus an exhaustive check over small inputs
- the exact topics and data of every event
- ABI selectors of the errors and events
- the raw storage layout, checked against Solidity's layout

## Check

```sh
cargo stylus check --endpoint https://sepolia-rollup.arbitrum.io/rpc     # Arbitrum Sepolia
cargo stylus check --endpoint https://rpc.testnet.chain.robinhood.com    # Robinhood Chain testnet
cargo stylus export-abi --output abi.sol
```

Both chains pass the check. The contract is 15.2 KB compressed (the limit is 24 KB), and the
estimated activation data fee is about 0.0001 ETH.

Two build settings keep the contract small:
- The release profile uses `opt-level = 3`, LTO, strip, `panic = "abort"` and one codegen unit.
  With this SDK, `opt-level = 3` gave the smallest output: `"s"` came to 16.9 KB and `"z"` to
  22.5 KB.
- `.cargo/config.toml` shrinks the WASM shadow stack from 1 MiB to 32 KiB. The memory footprint
  drops from 17 pages to 1, which saves about 15k gas on **every** call.

## Gas

These figures were measured on a local Nitro dev node with a Solidity caller, and they include
the `CALL` overhead. The program was not cached. `XorvEscrow` forwards
`REGISTRY_GAS_LIMIT = 150_000` to the registry.

| `recordOutcome` case | gas |
|---|---|
| provider with no record, success (worst case: two fresh slots) | 72,110 |
| registered provider, first success | 54,980 |
| provider with no record, failure | 49,974 |
| existing record, success | 37,880 |
| existing record, failure | 32,844 |

In the worst case this uses less than half of the escrow's limit. About 19.6k of each figure is
the Stylus program-init cost for an uncached program. Caching the program with
`cargo stylus cache bid <addr> 0` lowers that part to about 3.0k.

## Deploy

```sh
RPC_URL=https://sepolia-rollup.arbitrum.io/rpc PRIVATE_KEY=0x... \
  OWNER=0x... ESCROW=0x... OPERATOR=0x... CACHE_BID=0 ./deploy.sh
```

`deploy.sh` does the following:
1. Runs `cargo stylus check`.
2. Runs `cargo stylus deploy --constructor-args $OWNER`. This deploys, activates and
   initializes the contract in one transaction through the chain's `StylusDeployer`
   (`0xcEcba2F1…A990`, present on both chains above). It uses a reproducible Docker build when
   Docker is reachable, and `--no-verify` otherwise.
3. Parses the deployed address from the output.
4. Checks that `owner()` is set. If it is still zero, it calls `initialize(OWNER)` as a fallback.
5. If the deployer is the owner, sets the escrow and operator when they are given.
6. Places a cache bid if `CACHE_BID` is set.
7. Prints the address.

After you deploy the registry, point the escrow at it with `XorvEscrow.setRegistry(<address>)`,
and point the registry back at the escrow with `setEscrow(<escrow>)`. Both links must be set
before outcomes are recorded.
