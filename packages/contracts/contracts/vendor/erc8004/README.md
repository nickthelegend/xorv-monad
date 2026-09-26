# Vendored ERC-8004 v2.0.0 registries (test-only)

These files are copied verbatim from
[erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) at commit
`b9e466c250744a7e06b13dff9d3c2844ed64f825` (2026-08-15). That commit is the source of the v2.0.0
registries deployed on Monad (`getVersion()` returns `"2.0.0"` on both chains). The only change is
a short attribution comment under each SPDX line.

| File | Upstream path | Role here |
|---|---|---|
| `IdentityRegistryUpgradeable.sol` | `contracts/IdentityRegistryUpgradeable.sol` | agent NFTs, `getAgentWallet`, `isAuthorizedOrOwner` |
| `ReputationRegistryUpgradeable.sol` | `contracts/ReputationRegistryUpgradeable.sol` | `giveFeedback` with the self-feedback guard |
| `HardhatMinimalUUPS.sol` | `contracts/HardhatMinimalUUPS.sol` | UUPS placeholder the proxies start on (owner = deployer) |
| `ERC1967Proxy.sol` | `contracts/ERC1967Proxy.sol` | re-export of OpenZeppelin's proxy so it can be deployed by name |

**License.** Each file carries `SPDX-License-Identifier: MIT` and is © the ERC-8004 authors. The
upstream README says CC0. Either way the files are permissive and redistributable.

**Why vendor instead of mocking.** XorvLedger's safety depends on registry behaviour. For example,
`getAgentWallet` returns `address(0)` for cleared and never-minted agents, and `giveFeedback` rejects
feedback from an agent's owner or operators. `test/XorvLedger.test.ts` deploys these contracts the
way upstream's own tests do (an ERC1967 proxy over `HardhatMinimalUUPS`, then `upgradeToAndCall` into
the real implementation). This means the tests exercise the registry code that runs on Monad, not a
mock's approximation of it.

**Build settings.** `hardhat.config.ts` compiles these files with `viaIR: true` and optimizer 200,
as upstream does, but with evmVersion `cancun` rather than upstream's `shanghai`. They need
`@openzeppelin/contracts-upgradeable` 5.4.x, because 5.5 removed `__UUPSUpgradeable_init`. This
package never deploys them to a live network.

**Updating.** Copy the files again from a newer upstream commit, keep the attribution header, update
the commit hash above, and run `pnpm --filter @xorv/contracts test`.
