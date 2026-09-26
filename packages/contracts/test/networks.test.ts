import assert from "node:assert/strict";
import { describe, it } from "node:test";

import hre from "hardhat";

import {
  DEFAULT_FORK_RPC_URL,
  MONAD_DEPLOYMENTS,
  monadDeploymentFor,
  monadDeploymentForChainId,
} from "../scripts/lib/networks.js";

// The e2e harness (e2e/) serves a fork of Monad testnet with `hardhat node --network monadFork` and
// deploys XorvLedger to it with `scripts/deploy.ts --network monadForkRpc`. These pin the parts of
// that setup that fail silently or only against a live fork.

describe("Monad fork support", function () {
  it("recognises a fork by its chain id, but never by the fork's network name", function () {
    assert.equal(monadDeploymentForChainId(10143)?.network, "monadTestnet");
    assert.equal(monadDeploymentForChainId(143)?.network, "monad");
    assert.equal(monadDeploymentForChainId(31337), undefined);
    // By name, the fork networks are not Monad deployments: nothing may be written to
    // deployments/monadTestnet.json from a fork, and the redeploy guard must not apply to one.
    assert.equal(monadDeploymentFor("monadFork"), undefined);
    assert.equal(monadDeploymentFor("monadForkRpc"), undefined);
  });

  it("forks Monad testnet as chain 10143, mining Prague blocks", function () {
    const fork = hre.config.networks.monadFork;
    assert.equal(fork?.type, "edr-simulated");
    if (fork?.type !== "edr-simulated") return;
    assert.equal(fork.chainId, MONAD_DEPLOYMENTS.monadTestnet.chainId);
    assert.equal(fork.hardfork, "prague");
    assert.ok(fork.forking, "monadFork must fork a remote chain");
  });

  it("gives chain 10143 a hardfork history EDR actually receives, or it refuses calls at the fork block", function () {
    // Without it every eth_call against the forked block itself fails with "No known hardfork for
    // execution on historical block … in chain with id 10143".
    const descriptor = hre.config.chainDescriptors.get(10143n);
    assert.ok(descriptor?.hardforkHistory?.has("prague"), "chainDescriptors[10143].hardforkHistory must name prague");
    // Hardhat hands a descriptor's history to the fork only when its chain type is the forking
    // network's. A chain Hardhat has no default descriptor for is "generic" unless it says otherwise,
    // and an "l1" fork silently drops a generic descriptor: the history above would be dead config.
    const fork = hre.config.networks.monadFork;
    assert.equal(descriptor?.chainType, fork?.chainType);
  });

  it("reaches the fork over JSON-RPC with the node's own accounts", function () {
    const rpc = hre.config.networks.monadForkRpc;
    assert.equal(rpc?.type, "http");
    if (rpc?.type !== "http") return;
    assert.equal(rpc.chainId, 10143);
    assert.equal(rpc.accounts, "remote");
    assert.ok(DEFAULT_FORK_RPC_URL.startsWith("http://127.0.0.1:"));
  });
});
