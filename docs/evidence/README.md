# Evidence that isn't on chain

## The MCP agent's Privy server wallet

| | |
|---|---|
| Wallet | `0x6613490F1A424e7595149D26cF4e274C9C0a40fB` (Privy server wallet id `yhjrrwq3tbhl4ll3zewefvha`) |
| Policy | `u89ezf36ig9fp8uei9o61s31` |
| Rules | [privy-agent-policy.json](privy-agent-policy.json), the exact rules `pnpm --filter @xorv/mcp privy:setup --dry-run` builds |

The rules are:
- **Payments:** USDC `TransferWithAuthorization` of at most $0.05.
- **Escrow:** USDC `ReceiveWithAuthorization` of at most $0.05, into XorvEscrow `0x87d5…Df91` only.
- **Ratings:** EIP-712 job ratings on XorvLedger `0x4091…8408` only.

Privy refuses to sign anything else. That refusal was observed live twice on 13 Oct: an escrow payment before the escrow rule existed, and a rating against the old ledger. Both failed with `policy_violation` until the matching rule was added (see the commit history).

Every `xorv_run_job` result names the payer as `Privy server wallet yhjrrwq3tbhl4ll3zewefvha 0x6613…40fB (policy u89ezf36ig9fp8uei9o61s31)`. The wallet and policy ids are identifiers, not secrets. Signing needs the app secret, which is never in the repo.
