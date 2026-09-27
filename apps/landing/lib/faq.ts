/**
 * The questions a careful person actually asks.
 *
 * Including the uncomfortable ones. Someone is about to run prompts from
 * strangers against a paid account on their own laptop; pretending that has no
 * downside is the fastest way to lose them.
 */
export const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "Is this against my AI provider's terms of service?",
    a: "Possibly — check yours. Most consumer AI subscriptions are licensed to one person, and reselling that capacity may breach them. Xorv is infrastructure and doesn't decide this for you. Where your plan's terms forbid resale, sell through an API-key backend instead — the Qwen 3.8 Max, Kimi K3 and Hunyuan adapters, a team or enterprise plan that permits it, or your own local models through the OpenAI-compatible adapter.",
  },
  {
    q: "What can a stranger's prompt do to my machine?",
    a: "Each job runs inside an OS-level sandbox — seatbelt on macOS, bubblewrap on Linux, or a container if you opt in — in a fresh directory that is deleted when the job ends. Your payout key, SSH keys and cloud credentials are unreadable, and the job inherits an allowlisted environment rather than your shell. On a host with neither seatbelt nor bubblewrap there is no filesystem boundary, and xorv doctor says so. Set XORV_SAFE_MODE=1 to disable tools and sell text generation only.",
  },
  {
    q: "Do I need MON for gas, to buy or to earn?",
    a: "No. A buyer signs an EIP-3009 authorization — a message, not a transaction — and Xorv's facilitator submits it and pays the MON gas, so the buyer only ever holds USDC. A provider only needs an address that can receive USDC, which on Monad is any address. The one optional thing a provider pays gas for is minting an ERC-8004 identity: a single transaction that needs a little MON.",
  },
  {
    q: "Is the broker a middleman that can take a cut?",
    a: "It isn't the payee. The 402 response names the matched provider's own address, the buyer's client checks it against the frozen quote before signing, and once signed the recipient can't be changed — it is part of the signed message. USDC moves from buyer to provider in one transfer and the broker never has custody. The protocol fee is currently zero.",
  },
  {
    q: "What happens if a provider fails or disappears mid-job?",
    a: "The job is reassigned to another live provider at no extra cost to the buyer. The failure counts against the original provider's success rate in the broker's matcher, which is what it sorts on, so a provider who keeps failing stops winning jobs. On-chain the job still gets exactly one receipt, for its final outcome, recorded without an agent identity because the provider that was paid is not the one that finished the work. A failed receipt is written only when no other provider can take the job. There is no refund path today.",
  },
  {
    q: "Can a provider fake its own reputation?",
    a: "Not cheaply. Only the wallet that paid for a job can rate it, and before relaying a rating the broker asks Nansen whether buyer and provider are the same party — one funded the other, both were first funded by the same non-exchange wallet, or Nansen lists them as related. If so the rating is refused and nothing reaches ERC-8004. A lookup that fails never counts against anyone.",
  },
  {
    q: "What does the chain record — and what doesn't it?",
    a: "XorvLedger records provider registrations, sampled heartbeats, one receipt per job — job id, ERC-8004 agent, buyer, payee, amount, settlement transaction, duration, success, and keccak-256 hashes of the prompt and the result — and every rating. Never the prompt or the result themselves: a hash lets anyone holding the text prove it matches, and tells everyone else nothing.",
  },
  {
    q: "Are private jobs actually private?",
    a: "The result is. On a private job the provider seals the result to a key derived from your passkey before it leaves their node, so the broker only ever stores ciphertext and the on-chain hash commits to that ciphertext — and the same passkey opens it on your other devices. The prompt stays readable to the screener, the router and the provider running it, because a model can't work on text it can't read. The AI verifier skips private jobs.",
  },
  {
    q: "Why Monad?",
    a: "Because x402 pays before the work starts, and on Monad that wait is one ~300 ms block, final in about 600 ms — shorter than a job takes to start. Gas is small enough that settling a one-cent job isn't eaten by its fee. It's EVM, so USDC's EIP-3009 authorizations give buyers a gasless payment with no custom token work, and ERC-8004's identity and reputation registries are already deployed here — so a provider's reputation lives in a standard any marketplace can read, not in our database.",
  },
  {
    q: "Can an agent use this without a human?",
    a: "That's the point. Xorv ships an MCP server that pays from a Privy server wallet under a spending policy, and a MetaMask Agent Wallet plugin that pays under the user's MetaMask policy. Either way an agent discovers capacity, prices a job, pays for it and gets the result back with a Monad explorer link — no account, no card, no human in the loop. Both carry a hard per-job ceiling, because a model that can spend without a bound can empty a wallet through a loop it didn't mean to write.",
  },
];
