import assert from "node:assert/strict";
import { describe, it } from "node:test";

import hre from "hardhat";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { chooseLedgerOwner, deployerKeyVariable, operatorAddress } from "../scripts/lib/owner.js";

// The ledger's owner is the only way to rotate a leaked broker key out. The deploy script used to
// make the deployer the owner, and the deployer was the broker's own XORV_OPERATOR_KEY whenever
// XORV_DEPLOYER_KEY wasn't in the environment, even when it was in the Hardhat keystore. These pin
// the replacement: the keystore wins over the operator key, and the owner is never the broker's hot
// key on a real network unless someone says so.

const operatorKey = generatePrivateKey();
const operator = privateKeyToAccount(operatorKey).address;
const deployer = privateKeyToAccount(generatePrivateKey()).address;
const cold = privateKeyToAccount(generatePrivateKey()).address;

describe("deployer key", function () {
  it("is always XORV_DEPLOYER_KEY, so the keystore is asked before the operator key is used", function () {
    // With only the operator key in the environment, the old config named XORV_OPERATOR_KEY outright
    // and a keystore-held XORV_DEPLOYER_KEY was never consulted.
    const withOperator = deployerKeyVariable({ XORV_OPERATOR_KEY: operatorKey });
    assert.equal(withOperator.name, "XORV_DEPLOYER_KEY");
    assert.equal(withOperator.default, operatorKey);

    const alone = deployerKeyVariable({});
    assert.equal(alone.name, "XORV_DEPLOYER_KEY");
    assert.equal(alone.default, undefined);
    // `.env.example` ships blank lines: a blank operator key is no fallback.
    assert.equal(deployerKeyVariable({ XORV_OPERATOR_KEY: "  " }).default, undefined);
  });

  it("is what both Monad networks deploy with, whatever the environment holds", function () {
    for (const name of ["monadTestnet", "monad"] as const) {
      const net = hre.config.networks[name];
      assert.equal(net?.type, "http");
      if (net?.type !== "http" || !Array.isArray(net.accounts)) throw new Error(`${name} has no account list`);
      assert.equal(net.accounts.length, 1);
      assert.equal((net.accounts[0] as unknown as { name: string }).name, "XORV_DEPLOYER_KEY");
    }
  });

  it("recognises the operator key's address, with or without 0x, and ignores junk", function () {
    assert.equal(operatorAddress({ XORV_OPERATOR_KEY: operatorKey }), operator);
    assert.equal(operatorAddress({ XORV_OPERATOR_KEY: operatorKey.slice(2) }), operator);
    assert.equal(operatorAddress({ XORV_OPERATOR_KEY: "not a key" }), undefined);
    assert.equal(operatorAddress({}), undefined);
  });
});

describe("ledger owner", function () {
  it("is XORV_LEDGER_OWNER when set, the deployer otherwise", function () {
    assert.deepEqual(chooseLedgerOwner({ env: { XORV_LEDGER_OWNER: cold.toLowerCase() }, deployer, broker: operator, live: true }), {
      owner: getAddress(cold),
      source: "XORV_LEDGER_OWNER",
    });
    assert.deepEqual(chooseLedgerOwner({ env: { XORV_LEDGER_OWNER: " " }, deployer, broker: operator, live: true }), {
      owner: deployer,
      source: "deployer",
    });
    assert.throws(
      () => chooseLedgerOwner({ env: { XORV_LEDGER_OWNER: "0x1234" }, deployer, broker: operator, live: true }),
      /XORV_LEDGER_OWNER is not an address/,
    );
  });

  it("refuses the broker as owner on a real network: the documented operator-only deploy", function () {
    // XORV_BROKER_ADDRESS=<operator> with only XORV_OPERATOR_KEY set: the operator deploys, and was the owner.
    const env = { XORV_OPERATOR_KEY: operatorKey };
    assert.throws(() => chooseLedgerOwner({ env, deployer: operator, broker: operator, live: true }), (err: Error) => {
      assert.match(err.message, /is the broker/);
      assert.match(err.message, /XORV_LEDGER_OWNER/);
      return true;
    });
    // Naming a cold owner makes the same deployment fine: the operator key only pays.
    assert.equal(
      chooseLedgerOwner({ env: { ...env, XORV_LEDGER_OWNER: cold }, deployer: operator, broker: operator, live: true }).owner,
      getAddress(cold),
    );
  });

  it("refuses the operator key's address as owner even when the broker is another address", function () {
    const env = { XORV_OPERATOR_KEY: operatorKey, XORV_LEDGER_OWNER: operator };
    assert.throws(() => chooseLedgerOwner({ env, deployer, broker: cold, live: true }), /operator key/);
  });

  it("goes ahead with a warning when opted in, or on a local chain or fork", function () {
    const opted = chooseLedgerOwner({ env: { XORV_ALLOW_OWNER_IS_BROKER: "1" }, deployer, broker: deployer, live: true });
    assert.equal(opted.owner, deployer);
    assert.match(opted.warning ?? "", /broker/);

    const local = chooseLedgerOwner({ env: {}, deployer, broker: deployer, live: false });
    assert.equal(local.owner, deployer);
    assert.ok(local.warning);

    // A separate deployer key and an operator broker: no warning at all.
    assert.equal(chooseLedgerOwner({ env: { XORV_OPERATOR_KEY: operatorKey }, deployer, broker: operator, live: true }).warning, undefined);
  });
});
