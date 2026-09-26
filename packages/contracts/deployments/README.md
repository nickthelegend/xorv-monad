# Deployments

`scripts/deploy.ts` writes one `<network>.json` per Monad network the ledger is deployed to:

```jsonc
{
  "contract": "XorvLedger",
  "network": "monadTestnet",
  "chainId": 10143,
  "address": "0x…",
  "txHash": "0x…",
  "blockNumber": 0,          // XORV_LEDGER_FROM_BLOCK / ENVIO_XORV_LEDGER_START_BLOCK
  "identity": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  "reputation": "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  "broker": "0x…",
  "owner": "0x…",
  "deployedAt": "2026-…Z"
}
```

Only `monadTestnet.json` and `monad.json` are committed. Once one of them exists, the deploy script
refuses to overwrite it unless you set `XORV_REDEPLOY=1`, because a redeploy moves the ledger to a
new address. `scripts/verify.ts` reads the same file to verify the contract.
