// SPDX-License-Identifier: MIT
// Vendored verbatim from https://github.com/erc-8004/erc-8004-contracts
// (contracts/ERC1967Proxy.sol at commit b9e466c250744a7e06b13dff9d3c2844ed64f825, the
// source of the v2.0.0 registries deployed on Monad). Copyright the ERC-8004 authors,
// MIT-licensed per the SPDX header above. Used only to run XorvLedger's tests against the
// real registry logic behind ERC1967 proxies; never deployed by this package.
// See contracts/vendor/erc8004/README.md. Do not edit: re-vendor instead.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol" as OZProxy;

// This contract just re-exports OpenZeppelin's ERC1967Proxy
// so it can be compiled and used in our tests and deployment scripts
contract ERC1967Proxy is OZProxy.ERC1967Proxy {
    constructor(address implementation, bytes memory _data) OZProxy.ERC1967Proxy(implementation, _data) {}
}
