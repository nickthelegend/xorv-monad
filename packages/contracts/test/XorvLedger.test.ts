import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  type LocalAccount,
  type WalletClient,
  getAddress,
  hashTypedData,
  keccak256,
  parseEventLogs,
  recoverTypedDataAddress,
  toFunctionSelector,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  NO_AGENT,
  NO_AGENT_ID,
  type JobReceipt,
  deployErc8004,
  makeRating,
  makeReceipt,
  ratingTypedData,
  registerAgent,
  signRating,
  textHash,
} from "./helpers.js";

// These tests run XorvLedger against the real ERC-8004 v2.0.0 registries (vendored from
// erc-8004/erc-8004-contracts, behind ERC1967 proxies), so the self-feedback guard, agentWallet
// semantics and feedback storage are the registry's own code rather than a mock's idea of it.

describe("XorvLedger", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [deployer, broker, provider, buyer, stranger, provider2] = await viem.getWalletClients();
  if (!deployer || !broker || !provider || !buyer || !stranger || !provider2) throw new Error("need 6 accounts");

  const PROVIDER_ID = textHash("node-7f3a");
  const CAPABILITIES = "claude-code:10000,qwen:5000";

  async function deployLedgerFixture() {
    const { identity, reputation } = await deployErc8004(viem);
    // The provider registers its node as an ERC-8004 agent from its payout wallet, so the
    // registry's agentWallet defaults to that same address.
    const agentId = await registerAgent(viem, identity, provider!, "https://broker.xorv.xyz/agents/node-7f3a.json");
    const agentId2 = await registerAgent(viem, identity, provider2!, "https://broker.xorv.xyz/agents/node-9c01.json");
    const ledger = await viem.deployContract("XorvLedger", [identity.address, reputation.address, broker!.account.address]);
    const asBroker = await viem.getContractAt("XorvLedger", ledger.address, { client: { wallet: broker! } });
    return { identity, reputation, ledger, asBroker, agentId, agentId2 };
  }

  const load = () => networkHelpers.loadFixture(deployLedgerFixture);

  /** Every message, detail and revert payload along an error's cause chain, as one string. */
  function errorText(err: unknown): string {
    const parts: string[] = [];
    let current: unknown = err;
    while (current instanceof Error) {
      const { data, details } = current as Error & { data?: unknown; details?: unknown };
      parts.push(current.message, String(data ?? ""), String(details ?? ""));
      current = current.cause;
    }
    return parts.join(" | ");
  }

  /**
   * Points `agentId`'s verified payout wallet at `wallet`, as its owner `provider` would: the
   * registry wants the new wallet's EIP-712 consent, with a deadline at most five minutes out.
   */
  async function setAgentWallet(
    identity: Awaited<ReturnType<typeof deployErc8004>>["identity"],
    agentId: bigint,
    wallet: LocalAccount | WalletClient,
  ) {
    const local = wallet.type === "local" ? (wallet as LocalAccount) : undefined;
    const client = wallet as WalletClient;
    const newWallet = local ? local.address : client.account!.address;
    const deadline = BigInt(await networkHelpers.time.latest()) + 120n;
    const typedData = {
      domain: { name: "ERC8004IdentityRegistry", version: "1", chainId, verifyingContract: identity.address },
      types: {
        AgentWalletSet: [
          { name: "agentId", type: "uint256" },
          { name: "newWallet", type: "address" },
          { name: "owner", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "AgentWalletSet" as const,
      message: { agentId, newWallet, owner: provider!.account.address, deadline },
    };
    const signature = local
      ? await local.signTypedData(typedData)
      : await client.signTypedData({ ...typedData, account: client.account! });
    await identity.write.setAgentWallet([agentId, newWallet, deadline, signature], { account: provider!.account });
    assert.equal(await identity.read.getAgentWallet([agentId]), getAddress(newWallet));
  }

  /** A receipt for `buyer` paying `provider` (agent 0) unless overridden. */
  function receiptFor(n: number | string, agentId: bigint, fields: Partial<JobReceipt> = {}): JobReceipt {
    return makeReceipt(n, { agentId, buyer: buyer!.account.address, payTo: provider!.account.address, ...fields });
  }

  describe("deployment", function () {
    it("wires the registries, makes the deployer owner and emits both roles", async function () {
      const { identity, reputation, ledger } = await load();
      assert.equal(await ledger.read.identity(), getAddress(identity.address));
      assert.equal(await ledger.read.reputation(), getAddress(reputation.address));
      assert.equal(await ledger.read.owner(), getAddress(deployer.account.address));
      assert.equal(await ledger.read.broker(), getAddress(broker.account.address));

      const ownership = await ledger.getEvents.OwnershipTransferred({}, { fromBlock: 0n });
      assert.equal(ownership.length, 1);
      assert.equal(ownership[0]?.args.previousOwner, zeroAddress);
      assert.equal(ownership[0]?.args.newOwner, getAddress(deployer.account.address));
      const brokerSet = await ledger.getEvents.BrokerSet({}, { fromBlock: 0n });
      assert.equal(brokerSet[0]?.args.broker, getAddress(broker.account.address));
    });

    it("exposes the spec constants and the EIP-712 domain", async function () {
      const { ledger } = await load();
      assert.equal(await ledger.read.NO_AGENT(), NO_AGENT);
      assert.equal(
        await ledger.read.RATING_TYPEHASH(),
        keccak256(
          toHex(
            "Rating(bytes32 jobId,int128 value,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash,uint256 deadline)",
          ),
        ),
      );
      const [, name, version, domainChainId, verifyingContract] = await ledger.read.eip712Domain();
      assert.equal(name, "XorvLedger");
      assert.equal(version, "1");
      assert.equal(domainChainId, BigInt(chainId));
      assert.equal(verifyingContract, getAddress(ledger.address));
    });

    it("refuses zero addresses in the constructor", async function () {
      const { identity, reputation } = await load();
      const selector = toFunctionSelector("ZeroAddress()");
      for (const args of [
        [zeroAddress, reputation.address, broker.account.address],
        [identity.address, zeroAddress, broker.account.address],
        [identity.address, reputation.address, zeroAddress],
      ] as const) {
        // A reverted deployment has no contract to decode against, so match the error by name
        // or by its selector, whichever the client surfaced.
        await assert.rejects(viem.deployContract("XorvLedger", [...args]), (err: unknown) => {
          const text = errorText(err);
          return text.includes("ZeroAddress") || text.includes(selector);
        });
      }
    });
  });

  describe("admin", function () {
    it("only the owner can set the broker", async function () {
      const { ledger } = await load();
      for (const caller of [stranger, broker]) {
        await viem.assertions.revertWithCustomError(
          ledger.write.setBroker([stranger.account.address], { account: caller.account }),
          ledger,
          "NotOwner",
        );
      }
      await viem.assertions.revertWithCustomError(ledger.write.setBroker([zeroAddress]), ledger, "ZeroAddress");
    });

    it("rotating the broker moves write access and emits BrokerSet", async function () {
      const { ledger, agentId } = await load();
      await viem.assertions.emitWithArgs(ledger.write.setBroker([stranger.account.address]), ledger, "BrokerSet", [
        getAddress(stranger.account.address),
      ]);
      assert.equal(await ledger.read.broker(), getAddress(stranger.account.address));

      await viem.assertions.revertWithCustomError(
        ledger.write.recordJobs([[receiptFor(1, agentId)]], { account: broker.account }),
        ledger,
        "NotBroker",
      );
      await ledger.write.recordJobs([[receiptFor(1, agentId)]], { account: stranger.account });
    });

    it("only the owner can transfer ownership; the new owner takes over", async function () {
      const { ledger } = await load();
      await viem.assertions.revertWithCustomError(
        ledger.write.transferOwnership([stranger.account.address], { account: stranger.account }),
        ledger,
        "NotOwner",
      );
      await viem.assertions.revertWithCustomError(ledger.write.transferOwnership([zeroAddress]), ledger, "ZeroAddress");

      await viem.assertions.emitWithArgs(
        ledger.write.transferOwnership([stranger.account.address]),
        ledger,
        "OwnershipTransferred",
        [getAddress(deployer.account.address), getAddress(stranger.account.address)],
      );
      assert.equal(await ledger.read.owner(), getAddress(stranger.account.address));

      await viem.assertions.revertWithCustomError(ledger.write.setBroker([provider.account.address]), ledger, "NotOwner");
      await ledger.write.setBroker([provider.account.address], { account: stranger.account });
      assert.equal(await ledger.read.broker(), getAddress(provider.account.address));
    });
  });

  describe("registerProvider", function () {
    it("is broker-only", async function () {
      const { ledger } = await load();
      for (const caller of [deployer, stranger]) {
        await viem.assertions.revertWithCustomError(
          ledger.write.registerProvider([PROVIDER_ID, provider.account.address, NO_AGENT, "node", CAPABILITIES], {
            account: caller.account,
          }),
          ledger,
          "NotBroker",
        );
      }
    });

    it("registers a provider bound to its ERC-8004 agent wallet", async function () {
      const { asBroker, identity, agentId } = await load();
      assert.equal(await identity.read.getAgentWallet([agentId]), getAddress(provider.account.address));
      await viem.assertions.emitWithArgs(
        asBroker.write.registerProvider([PROVIDER_ID, provider.account.address, agentId, "node-7f3a (Claude Code)", CAPABILITIES]),
        asBroker,
        "ProviderRegistered",
        [PROVIDER_ID, getAddress(provider.account.address), agentId, "node-7f3a (Claude Code)", CAPABILITIES],
      );
    });

    it("rejects a payTo that is not the agent's wallet", async function () {
      const { asBroker, agentId } = await load();
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.registerProvider([PROVIDER_ID, stranger.account.address, agentId, "node", CAPABILITIES]),
        asBroker,
        "PayToNotAgentWallet",
        [agentId, getAddress(stranger.account.address), getAddress(provider.account.address)],
      );
    });

    it("rejects an agentId that was never minted (its wallet reads as zero)", async function () {
      const { asBroker } = await load();
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.registerProvider([PROVIDER_ID, provider.account.address, 999n, "node", CAPABILITIES]),
        asBroker,
        "PayToNotAgentWallet",
        [999n, getAddress(provider.account.address), zeroAddress],
      );
    });

    it("rejects the agent once its NFT is transferred (the registry clears agentWallet)", async function () {
      const { asBroker, identity, agentId } = await load();
      await identity.write.transferFrom([provider.account.address, stranger.account.address, agentId], {
        account: provider.account,
      });
      assert.equal(await identity.read.getAgentWallet([agentId]), zeroAddress);
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.registerProvider([PROVIDER_ID, provider.account.address, agentId, "node", CAPABILITIES]),
        asBroker,
        "PayToNotAgentWallet",
        [agentId, getAddress(provider.account.address), zeroAddress],
      );
      // And a zero payTo can't sneak past the cleared wallet.
      await viem.assertions.revertWithCustomError(
        asBroker.write.registerProvider([PROVIDER_ID, zeroAddress, agentId, "node", CAPABILITIES]),
        asBroker,
        "ZeroAddress",
      );
    });

    it("registers a provider without an agent (NO_AGENT) for any payTo", async function () {
      const { asBroker } = await load();
      await viem.assertions.emitWithArgs(
        asBroker.write.registerProvider([PROVIDER_ID, stranger.account.address, NO_AGENT, "no-agent node", "codex:8000"]),
        asBroker,
        "ProviderRegistered",
        [PROVIDER_ID, getAddress(stranger.account.address), NO_AGENT, "no-agent node", "codex:8000"],
      );
      await viem.assertions.revertWithCustomError(
        asBroker.write.registerProvider([PROVIDER_ID, zeroAddress, NO_AGENT, "node", CAPABILITIES]),
        asBroker,
        "ZeroAddress",
      );
    });

    it("rejects agentIds that don't fit the packed job slot", async function () {
      const { asBroker } = await load();
      for (const tooLarge of [NO_AGENT_ID, NO_AGENT - 1n]) {
        await viem.assertions.revertWithCustomError(
          asBroker.write.registerProvider([PROVIDER_ID, provider.account.address, tooLarge, "node", CAPABILITIES]),
          asBroker,
          "AgentIdTooLarge",
        );
      }
    });
  });

  describe("heartbeat", function () {
    it("is broker-only and emits the sample", async function () {
      const { ledger, asBroker } = await load();
      await viem.assertions.revertWithCustomError(
        ledger.write.heartbeat([PROVIDER_ID, 1, 4, 3600], { account: stranger.account }),
        ledger,
        "NotBroker",
      );
      await viem.assertions.emitWithArgs(asBroker.write.heartbeat([PROVIDER_ID, 1, 4, 3600]), asBroker, "ProviderHeartbeat", [
        PROVIDER_ID,
        1,
        4,
        3600,
      ]);
    });
  });

  describe("recordJobs", function () {
    it("is broker-only", async function () {
      const { ledger, agentId } = await load();
      for (const caller of [deployer, stranger, buyer]) {
        await viem.assertions.revertWithCustomError(
          ledger.write.recordJobs([[receiptFor(1, agentId)]], { account: caller.account }),
          ledger,
          "NotBroker",
        );
      }
    });

    it("stores one packed JobState and emits every receipt field", async function () {
      const { asBroker, agentId } = await load();
      const r = receiptFor(1, agentId, { durationMs: 1234, ok: false, amount: 1_000_001n });
      await viem.assertions.emitWithArgs(asBroker.write.recordJobs([[r]]), asBroker, "JobRecorded", [
        r.jobId,
        agentId,
        getAddress(r.buyer),
        getAddress(r.payTo),
        r.amount,
        r.paymentTx,
        r.requestHash,
        r.resultHash,
        r.durationMs,
        r.ok,
      ]);
      assert.deepEqual(await asBroker.read.jobs([r.jobId]), [getAddress(r.buyer), agentId, false]);
    });

    it("records a batch in order, across providers, in one transaction", async function () {
      const { asBroker, agentId, agentId2 } = await load();
      const batch = [
        receiptFor("a", agentId),
        receiptFor("b", agentId2, { payTo: provider2.account.address }),
        receiptFor("c", agentId),
        receiptFor("d", NO_AGENT, { payTo: stranger.account.address, paymentTx: zeroHash }),
      ];
      const hash = await asBroker.write.recordJobs([batch]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({ abi: asBroker.abi, logs: receipt.logs, eventName: "JobRecorded" });
      assert.deepEqual(
        events.map((e) => [e.args.jobId, e.args.agentId, e.args.payTo]),
        batch.map((r) => [r.jobId, r.agentId, getAddress(r.payTo)]),
      );
      for (const r of batch) {
        const [storedBuyer, storedAgent, rated] = await asBroker.read.jobs([r.jobId]);
        assert.equal(storedBuyer, getAddress(r.buyer));
        assert.equal(storedAgent, r.agentId === NO_AGENT ? NO_AGENT_ID : r.agentId);
        assert.equal(rated, false);
      }
    });

    it("rejects a job that is already recorded", async function () {
      const { asBroker, agentId } = await load();
      const r = receiptFor(1, agentId);
      await asBroker.write.recordJobs([[r]]);
      await viem.assertions.revertWithCustomErrorWithArgs(asBroker.write.recordJobs([[r]]), asBroker, "DuplicateJob", [r.jobId]);
    });

    it("rejects a duplicate inside one batch and writes nothing (all-or-nothing)", async function () {
      const { asBroker, agentId } = await load();
      const first = receiptFor(1, agentId);
      const second = receiptFor(2, agentId);
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.recordJobs([[first, second, { ...first, amount: 1n }]]),
        asBroker,
        "DuplicateJob",
        [first.jobId],
      );
      assert.equal((await asBroker.read.jobs([first.jobId]))[0], zeroAddress);
      assert.equal((await asBroker.read.jobs([second.jobId]))[0], zeroAddress);
    });

    it("binds payTo to the agent's verified wallet", async function () {
      const { asBroker, agentId } = await load();
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.recordJobs([[receiptFor(1, agentId, { payTo: stranger.account.address })]]),
        asBroker,
        "PayToNotAgentWallet",
        [agentId, getAddress(stranger.account.address), getAddress(provider.account.address)],
      );
    });

    it("re-checks when the payTo changes for the same agent within a batch", async function () {
      // recordJobs skips repeated getAgentWallet calls for an (agentId, payTo) pair it already
      // checked; the cache must key on both, or a bad payTo could ride on a good one.
      const { asBroker, agentId } = await load();
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.recordJobs([[receiptFor(1, agentId), receiptFor(2, agentId, { payTo: stranger.account.address })]]),
        asBroker,
        "PayToNotAgentWallet",
        [agentId, getAddress(stranger.account.address), getAddress(provider.account.address)],
      );
    });

    it("records NO_AGENT jobs without an identity check", async function () {
      const { asBroker } = await load();
      const r = receiptFor(1, NO_AGENT, { payTo: stranger.account.address });
      await viem.assertions.emitWithArgs(asBroker.write.recordJobs([[r]]), asBroker, "JobRecorded", [
        r.jobId,
        NO_AGENT,
        getAddress(r.buyer),
        getAddress(r.payTo),
        r.amount,
        r.paymentTx,
        r.requestHash,
        r.resultHash,
        r.durationMs,
        r.ok,
      ]);
      assert.deepEqual(await asBroker.read.jobs([r.jobId]), [getAddress(r.buyer), NO_AGENT_ID, false]);
    });

    it("rejects zero buyer, zero payTo and oversized agentIds", async function () {
      const { asBroker, agentId } = await load();
      await viem.assertions.revertWithCustomError(
        asBroker.write.recordJobs([[receiptFor(1, agentId, { buyer: zeroAddress })]]),
        asBroker,
        "ZeroAddress",
      );
      await viem.assertions.revertWithCustomError(
        asBroker.write.recordJobs([[receiptFor(1, NO_AGENT, { payTo: zeroAddress })]]),
        asBroker,
        "ZeroAddress",
      );
      await viem.assertions.revertWithCustomError(
        asBroker.write.recordJobs([[receiptFor(1, NO_AGENT_ID)]]),
        asBroker,
        "AgentIdTooLarge",
      );
    });

    it("refuses a receipt whose buyer is its own payTo, with or without an agent", async function () {
      // The provider pays itself (EIP-3009 allows from == to and the USDC comes straight back),
      // then would rate the job from that same wallet. The receipt itself is the thing refused.
      const { asBroker, agentId } = await load();
      const selfPaid = receiptFor("self", agentId, { buyer: provider.account.address });
      await viem.assertions.revertWithCustomErrorWithArgs(asBroker.write.recordJobs([[selfPaid]]), asBroker, "SelfDealing", [
        selfPaid.jobId,
      ]);
      const selfPaidNoAgent = receiptFor("self-na", NO_AGENT, { buyer: stranger.account.address, payTo: stranger.account.address });
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.recordJobs([[selfPaidNoAgent]]),
        asBroker,
        "SelfDealing",
        [selfPaidNoAgent.jobId],
      );

      // All-or-nothing like any other bad receipt: the honest one batched with it isn't written.
      const honest = receiptFor("honest", agentId);
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.recordJobs([[honest, selfPaid]]),
        asBroker,
        "SelfDealing",
        [selfPaid.jobId],
      );
      assert.equal((await asBroker.read.jobs([honest.jobId]))[0], zeroAddress);
      assert.equal((await asBroker.read.jobs([selfPaid.jobId]))[0], zeroAddress);
    });

    it("accepts an empty batch as a no-op", async function () {
      const { asBroker } = await load();
      const hash = await asBroker.write.recordJobs([[]]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert.equal(receipt.logs.length, 0);
    });
  });

  describe("rateJob", function () {
    async function recordedJobFixture() {
      const base = await deployLedgerFixture();
      const r = receiptFor("rated", base.agentId);
      await base.asBroker.write.recordJobs([[r]]);
      return { ...base, jobId: r.jobId };
    }
    const loadRecorded = () => networkHelpers.loadFixture(recordedJobFixture);

    it("buyer rates directly; the rating lands in ERC-8004 under the ledger as client", async function () {
      const { ledger, reputation, agentId, jobId } = await loadRecorded();
      const rating = makeRating(jobId);
      const hash = await ledger.write.rateJob([rating, "0x"], { account: buyer.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const [rated] = parseEventLogs({ abi: ledger.abi, logs: receipt.logs, eventName: "JobRated" });
      assert.deepEqual(rated?.args, {
        jobId,
        agentId,
        buyer: getAddress(buyer.account.address),
        value: rating.value,
        feedbackHash: rating.feedbackHash,
      });

      const [feedback] = parseEventLogs({ abi: reputation.abi, logs: receipt.logs, eventName: "NewFeedback" });
      assert.equal(getAddress(feedback?.address ?? zeroAddress), getAddress(reputation.address));
      assert.equal(feedback?.args.agentId, agentId);
      assert.equal(feedback?.args.clientAddress, getAddress(ledger.address));
      assert.equal(feedback?.args.feedbackIndex, 1n);
      assert.equal(feedback?.args.value, rating.value);
      assert.equal(feedback?.args.valueDecimals, 0);
      assert.equal(feedback?.args.tag1, "starred");
      assert.equal(feedback?.args.indexedTag1, keccak256(toHex("starred")));
      assert.equal(feedback?.args.tag2, rating.tag2);
      assert.equal(feedback?.args.endpoint, rating.endpoint);
      assert.equal(feedback?.args.feedbackURI, rating.feedbackURI);
      assert.equal(feedback?.args.feedbackHash, rating.feedbackHash);

      // Stored by the registry, readable by anyone, and summarised for the "paid jobs only" view.
      assert.deepEqual(await reputation.read.readFeedback([agentId, ledger.address, 1n]), [
        rating.value,
        0,
        "starred",
        rating.tag2,
        false,
      ]);
      assert.deepEqual(await reputation.read.getSummary([agentId, [ledger.address], "starred", ""]), [1n, rating.value, 0]);
      assert.deepEqual(await reputation.read.getClients([agentId]), [getAddress(ledger.address)]);
      assert.equal((await ledger.read.jobs([jobId]))[2], true);
    });

    it("ignores the deadline and the signature on the direct path", async function () {
      const { ledger, jobId } = await loadRecorded();
      const rating = makeRating(jobId, { deadline: 1n });
      await viem.assertions.emit(ledger.write.rateJob([rating, "0xdeadbeef"], { account: buyer.account }), ledger, "JobRated");
    });

    it("relays a buyer's EIP-712 signature from a viem account (gasless for the buyer)", async function () {
      const { asBroker, ledger, reputation, identity, agentId } = await loadRecorded();
      // A fresh viem account with no MON at all: it only ever signs.
      const buyerAccount = privateKeyToAccount(generatePrivateKey());
      const r = receiptFor("viem-buyer", agentId, { buyer: buyerAccount.address });
      await asBroker.write.recordJobs([[r]]);

      const rating = makeRating(r.jobId, { value: 77n, tag2: "qwen" });
      const typedData = ratingTypedData(chainId, ledger.address, rating);
      assert.equal(await ledger.read.ratingDigest([rating]), hashTypedData(typedData));

      const signature = await buyerAccount.signTypedData(typedData);
      assert.equal(await recoverTypedDataAddress({ ...typedData, signature }), buyerAccount.address);

      await viem.assertions.emitWithArgs(asBroker.write.rateJob([rating, signature]), asBroker, "JobRated", [
        r.jobId,
        agentId,
        buyerAccount.address,
        77n,
        rating.feedbackHash,
      ]);
      assert.deepEqual(await reputation.read.readFeedback([agentId, ledger.address, 1n]), [77n, 0, "starred", "qwen", false]);
      // The registry's view of who gave the feedback is the ledger, never the relayer.
      assert.equal(await identity.read.isAuthorizedOrOwner([ledger.address, agentId]), false);
    });

    it("lets anyone relay a valid signature, not just the broker", async function () {
      const { ledger, jobId } = await loadRecorded();
      const rating = makeRating(jobId);
      const signature = await signRating(buyer, chainId, ledger.address, rating);
      await viem.assertions.emit(ledger.write.rateJob([rating, signature], { account: stranger.account }), ledger, "JobRated");
    });

    it("accepts an ERC-1271 smart-account buyer", async function () {
      const { asBroker, ledger, reputation, agentId } = await loadRecorded();
      const owner = privateKeyToAccount(generatePrivateKey());
      const wallet = await viem.deployContract("ERC1271WalletMock", [owner.address]);
      const r = receiptFor("smart-account", agentId, { buyer: wallet.address });
      await asBroker.write.recordJobs([[r]]);

      const rating = makeRating(r.jobId, { value: 100n });
      const intruder = privateKeyToAccount(generatePrivateKey());
      await viem.assertions.revertWithCustomError(
        asBroker.write.rateJob([rating, await signRating(intruder, chainId, ledger.address, rating)]),
        asBroker,
        "BadSignature",
      );

      await viem.assertions.emitWithArgs(
        asBroker.write.rateJob([rating, await signRating(owner, chainId, ledger.address, rating)]),
        asBroker,
        "JobRated",
        [r.jobId, agentId, getAddress(wallet.address), 100n, rating.feedbackHash],
      );
      assert.equal((await reputation.read.getSummary([agentId, [ledger.address], "starred", ""]))[1], 100n);
    });

    it("rejects signatures from anyone but the buyer, or over different content", async function () {
      const { asBroker, ledger, jobId } = await loadRecorded();
      const rating = makeRating(jobId);

      const wrongSigner = await signRating(stranger, chainId, ledger.address, rating);
      await viem.assertions.revertWithCustomError(asBroker.write.rateJob([rating, wrongSigner]), asBroker, "BadSignature");

      // A signature over value 92 can't be replayed as a 100.
      const signed = await signRating(buyer, chainId, ledger.address, rating);
      await viem.assertions.revertWithCustomError(
        asBroker.write.rateJob([{ ...rating, value: 100n }, signed]),
        asBroker,
        "BadSignature",
      );
      await viem.assertions.revertWithCustomError(
        asBroker.write.rateJob([{ ...rating, feedbackURI: "https://evil.example/feedback.json" }, signed]),
        asBroker,
        "BadSignature",
      );

      // Nor carried over from another deployment (the domain binds verifyingContract) or chain.
      const otherLedger = await viem.deployContract("XorvLedger", [
        await ledger.read.identity(),
        await ledger.read.reputation(),
        broker.account.address,
      ]);
      const forOtherLedger = await signRating(buyer, chainId, otherLedger.address, rating);
      await viem.assertions.revertWithCustomError(asBroker.write.rateJob([rating, forOtherLedger]), asBroker, "BadSignature");
      const forOtherChain = await signRating(buyer, 143, ledger.address, rating);
      await viem.assertions.revertWithCustomError(asBroker.write.rateJob([rating, forOtherChain]), asBroker, "BadSignature");

      await viem.assertions.revertWithCustomError(asBroker.write.rateJob([rating, "0x"]), asBroker, "BadSignature");
    });

    it("rejects a relayed rating past its deadline, and accepts one at the deadline", async function () {
      const { asBroker, ledger, jobId } = await loadRecorded();
      const now = BigInt(await networkHelpers.time.latest());

      const stale = makeRating(jobId, { deadline: now - 1n });
      await viem.assertions.revertWithCustomError(
        asBroker.write.rateJob([stale, await signRating(buyer, chainId, ledger.address, stale)]),
        asBroker,
        "Expired",
      );

      const edge = makeRating(jobId, { deadline: now + 10n });
      const signature = await signRating(buyer, chainId, ledger.address, edge);
      await networkHelpers.time.setNextBlockTimestamp(now + 10n);
      await viem.assertions.emit(asBroker.write.rateJob([edge, signature]), asBroker, "JobRated");
    });

    it("allows one rating per job", async function () {
      const { asBroker, ledger, jobId } = await loadRecorded();
      await ledger.write.rateJob([makeRating(jobId), "0x"], { account: buyer.account });

      await viem.assertions.revertWithCustomErrorWithArgs(
        ledger.write.rateJob([makeRating(jobId, { value: 10n }), "0x"], { account: buyer.account }),
        ledger,
        "AlreadyRated",
        [jobId],
      );
      const second = makeRating(jobId, { value: 10n });
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.rateJob([second, await signRating(buyer, chainId, ledger.address, second)]),
        asBroker,
        "AlreadyRated",
        [jobId],
      );
    });

    it("bounds the value to 0..100", async function () {
      const { ledger, reputation, agentId, asBroker, jobId } = await loadRecorded();
      for (const value of [-1n, 101n, -(2n ** 127n)]) {
        await viem.assertions.revertWithCustomError(
          ledger.write.rateJob([makeRating(jobId, { value }), "0x"], { account: buyer.account }),
          ledger,
          "BadValue",
        );
      }
      const zero = receiptFor("zero", agentId);
      const hundred = receiptFor("hundred", agentId);
      await asBroker.write.recordJobs([[zero, hundred]]);
      await ledger.write.rateJob([makeRating(zero.jobId, { value: 0n }), "0x"], { account: buyer.account });
      await ledger.write.rateJob([makeRating(hundred.jobId, { value: 100n }), "0x"], { account: buyer.account });
      assert.deepEqual(await reputation.read.getSummary([agentId, [ledger.address], "starred", ""]), [2n, 50n, 0]);
    });

    it("refuses jobs whose provider has no agent", async function () {
      const { asBroker, ledger } = await loadRecorded();
      const r = receiptFor("no-agent", NO_AGENT, { payTo: stranger.account.address });
      await asBroker.write.recordJobs([[r]]);
      await viem.assertions.revertWithCustomErrorWithArgs(
        ledger.write.rateJob([makeRating(r.jobId), "0x"], { account: buyer.account }),
        ledger,
        "NoAgent",
        [r.jobId],
      );
    });

    it("refuses unknown jobs", async function () {
      const { ledger } = await loadRecorded();
      const unknown = textHash("never-recorded");
      await viem.assertions.revertWithCustomErrorWithArgs(
        ledger.write.rateJob([makeRating(unknown), "0x"], { account: buyer.account }),
        ledger,
        "UnknownJob",
        [unknown],
      );
    });

    it("only the recorded buyer counts as the direct caller", async function () {
      const { ledger, jobId } = await loadRecorded();
      // Not the buyer and no signature: treated as a relay with a bad signature.
      await viem.assertions.revertWithCustomError(
        ledger.write.rateJob([makeRating(jobId), "0x"], { account: provider.account }),
        ledger,
        "BadSignature",
      );
    });

    // The registry refuses feedback from an agent's owner and operators, but every rating reaches it
    // from the ledger, so the ledger has to apply that rule to the buyer itself. Otherwise a provider
    // pays its own node from the wallet that owns the agent (the USDC lands back in its payout
    // wallet) and rates itself, directly or through any relayer, and nothing off-chain ever sees it.

    it("refuses a rating from the agent's owner, when the agent pays out to another wallet", async function () {
      const { asBroker, ledger, identity, reputation, agentId } = await loadRecorded();
      const payout = privateKeyToAccount(generatePrivateKey());
      await setAgentWallet(identity, agentId, payout);
      // buyer (the owner) != payTo (the payout wallet), so the receipt itself is fine.
      const r = receiptFor("owner-pays", agentId, { buyer: provider.account.address, payTo: payout.address });
      await asBroker.write.recordJobs([[r]]);

      const rating = makeRating(r.jobId, { value: 100n });
      await viem.assertions.revertWithCustomErrorWithArgs(
        ledger.write.rateJob([rating, "0x"], { account: provider.account }),
        ledger,
        "SelfDealing",
        [r.jobId],
      );
      // Relaying its own signature through someone else changes nothing.
      const signature = await signRating(provider, chainId, ledger.address, rating);
      await viem.assertions.revertWithCustomErrorWithArgs(
        ledger.write.rateJob([rating, signature], { account: stranger.account }),
        ledger,
        "SelfDealing",
        [r.jobId],
      );
      assert.equal((await ledger.read.jobs([r.jobId]))[2], false);
      assert.deepEqual(await reputation.read.getSummary([agentId, [ledger.address], "starred", ""]), [0n, 0n, 0]);
    });

    it("refuses a rating from an operator of the agent, approved for all or for the one token", async function () {
      const { asBroker, ledger, identity, agentId, jobId } = await loadRecorded();
      await identity.write.setApprovalForAll([buyer.account.address, true], { account: provider.account });
      await viem.assertions.revertWithCustomErrorWithArgs(
        ledger.write.rateJob([makeRating(jobId), "0x"], { account: buyer.account }),
        ledger,
        "SelfDealing",
        [jobId],
      );

      const approved = privateKeyToAccount(generatePrivateKey());
      const r = receiptFor("approved", agentId, { buyer: approved.address });
      await asBroker.write.recordJobs([[r]]);
      await identity.write.approve([approved.address, agentId], { account: provider.account });
      const rating = makeRating(r.jobId);
      await viem.assertions.revertWithCustomErrorWithArgs(
        asBroker.write.rateJob([rating, await signRating(approved, chainId, ledger.address, rating)]),
        asBroker,
        "SelfDealing",
        [r.jobId],
      );

      // Revoking the approval makes the buyer an outsider again.
      await identity.write.setApprovalForAll([buyer.account.address, false], { account: provider.account });
      await viem.assertions.emit(ledger.write.rateJob([makeRating(jobId), "0x"], { account: buyer.account }), ledger, "JobRated");
    });

    it("checks the registry at rating time: a buyer who has since become the agent's wallet or owner can't rate", async function () {
      const { asBroker, ledger, identity, agentId, jobId } = await loadRecorded();
      const later = receiptFor("later", agentId);
      await asBroker.write.recordJobs([[later]]);

      // The provider points its payouts at the buyer after the job was recorded.
      await setAgentWallet(identity, agentId, buyer);
      await viem.assertions.revertWithCustomErrorWithArgs(
        ledger.write.rateJob([makeRating(jobId), "0x"], { account: buyer.account }),
        ledger,
        "SelfDealing",
        [jobId],
      );

      // Or hands the agent over to the buyer (which clears the wallet).
      await identity.write.transferFrom([provider.account.address, buyer.account.address, agentId], {
        account: provider.account,
      });
      assert.equal(await identity.read.getAgentWallet([agentId]), zeroAddress);
      await viem.assertions.revertWithCustomErrorWithArgs(
        ledger.write.rateJob([makeRating(later.jobId), "0x"], { account: buyer.account }),
        ledger,
        "SelfDealing",
        [later.jobId],
      );
    });

    it("the real registry blocks self-feedback, which is why the ledger must never operate an agent", async function () {
      const { ledger, reputation, identity, agentId, jobId } = await loadRecorded();
      // The provider can't rate itself straight into ERC-8004...
      await viem.assertions.revertWith(
        reputation.write.giveFeedback([agentId, 100n, 0, "starred", "", "", "", zeroHash], { account: provider.account }),
        "Self-feedback not allowed",
      );
      // ...and if a provider made the ledger an operator of its agent NFT, the registry would treat
      // every relayed rating as self-feedback: rateJob reverts and the job stays unrated.
      await identity.write.setApprovalForAll([ledger.address, true], { account: provider.account });
      await viem.assertions.revertWith(
        ledger.write.rateJob([makeRating(jobId), "0x"], { account: buyer.account }),
        "Self-feedback not allowed",
      );
      assert.equal((await ledger.read.jobs([jobId]))[2], false);
    });
  });

  describe("ratingDigest", function () {
    it("matches viem's hashTypedData and commits to every field", async function () {
      const { ledger } = await load();
      const base = makeRating(textHash("digest"));
      const digest = await ledger.read.ratingDigest([base]);
      assert.equal(digest, hashTypedData(ratingTypedData(chainId, ledger.address, base)));

      const variants = [
        { jobId: textHash("other") },
        { value: 91n },
        { tag2: "codex" },
        { endpoint: "https://other.example" },
        { feedbackURI: "ipfs://other" },
        { feedbackHash: textHash("other") },
        { deadline: base.deadline + 1n },
      ];
      for (const change of variants) {
        const changed = { ...base, ...change };
        const d = await ledger.read.ratingDigest([changed]);
        assert.notEqual(d, digest, `digest ignores ${Object.keys(change)[0]}`);
        assert.equal(d, hashTypedData(ratingTypedData(chainId, ledger.address, changed)));
      }
    });
  });
});
