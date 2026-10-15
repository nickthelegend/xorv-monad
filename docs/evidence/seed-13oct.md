# Seeded activity (13 Oct 2026, 21:30 IST): team-seeded for the demo

These jobs were **seeded by the team for the demo**. They are not organic users. Three fresh buyer wallets were created for the demo, and their keys are in a git-ignored file. The flow for each:
1. **Funding:** the hosted demo payer funded the buyer with 0.05 test USDC through an EIP-3009 `transferWithAuthorization`. The operator submitted it and paid the gas.
2. **Purchase:** the buyer bought one Kimi K3 job from the hosted provider (ERC-8004 agent #2252) through the Xorv MCP server, signing with its own key into XorvEscrow.
3. **Rating:** the buyer then rated the job (an EIP-712 signature, relayed into XorvLedger and ERC-8004).

| Buyer (team-seeded) | Funding | Job | Payment into escrow | Kimi verdict (ERC-8004 feedback) | Release | Rating |
|---|---|---|---|---|---|---|
| `0x8279…e468` | [`0xaaf45d…`](https://testnet.monadvision.com/tx/0xaaf45d5225e3e416eed780a39b6c8ec6c64f05cdd5a2c6e2a63f56b2dc672ef9) | `job_uqr20Kqph7WA` | [`0x6dc5f2…`](https://testnet.monadvision.com/tx/0x6dc5f28ee95ae4511c9f1722b41e3293bd68e902a28e3f4affaec634a65c8fc8) | 95/100, [`0xb994cf…`](https://testnet.monadvision.com/tx/0xb994cfc891684bd29459c8d437ec9743f2f1bf87371076d483e6852430f02604) (block 70723392) | [`0x8a16b6…`](https://testnet.monadvision.com/tx/0x8a16b6f52df91dcda3229aaa8af77956749834f777c70e009edd629b7995c72b) (block 70723395) | 90, [`0x8d7756…`](https://testnet.monadvision.com/tx/0x8d77565e264d32e0f477de1f4b8cfabda0ecccda82ebf11a01b37df241ff24d3) |
| `0xCDe1…70E8` | [`0x99a5cc…`](https://testnet.monadvision.com/tx/0x99a5ccb142cc72f8aeae83e36549b8a636210cba83755e97137bd3467d484d1d) | `job_Z0DrGr4s2jNl` | [`0x935d6d…`](https://testnet.monadvision.com/tx/0x935d6d12d46f8638a3bc2bb657d4df6939c859c75f417899fa3a2a657f1bfc5f) | 95/100, [`0x388a31…`](https://testnet.monadvision.com/tx/0x388a31339c6da4317fdeef99ac04310c5db8c8198557460b33a23df034c630e4) (block 70723492) | [`0x63f3b3…`](https://testnet.monadvision.com/tx/0x63f3b3909524dc7a714eaf2177ca83f728ccf3a6f2994d4e425bdb11fcb3d5dd) (block 70723494) | 86, [`0x02d156…`](https://testnet.monadvision.com/tx/0x02d1569183b6524db2e77ef83e88d7b61d58d73d526aefee97fd6e975e6a3c79) |
| `0xaD4E…C4E3` | [`0xaf0567…`](https://testnet.monadvision.com/tx/0xaf0567ef8e8221bdb2d164ecec14b7b51f33a005e1118ad0ae61ec3015c3e084) | `job_SdmoVTMg2Itz` | [`0x428d9f…`](https://testnet.monadvision.com/tx/0x428d9f34e44babfdaeeaf205b4d88dc0388436cd7147bbf37288aa0d6385aaee) | **none**: Moonshot rate-limited the verifier (3 requests a minute) | [`0x4bd07a…`](https://testnet.monadvision.com/tx/0x4bd07a0e3f0acec9378a8935bcf8b0508cb463aa9369a2b63591d630cade2339), after the 2-minute grace | 88, [`0x478811…`](https://testnet.monadvision.com/tx/0x478811c16b45684b021f8b7b9782c4649d65614ac6d702fd8792bc82b853ae3e) |

**What these show under the final gate (live since 20:25 IST):**
- In the first two jobs, Kimi's on-chain verdict lands *blocks before* the release (70723392 → 70723395, and 70723492 → 70723494).
- The third job shows the fallback: with no verdict, the provider is paid after the grace period instead of the money freezing.

**Cost:**
- 0.15 USDC from the demo payer: 3 × 0.05, of which 3 × 0.02 went to the jobs.
- About 0.64 MON in gas:
  - operator about 0.43: four funding transactions (one reverted out of gas and was retried), receipts, two verdict writes and three rating relays;
  - facilitator about 0.20: three escrow funds and releases.
