// SPDX-License-Identifier: MIT
// Vendored verbatim from https://github.com/erc-8004/erc-8004-contracts
// (contracts/HardhatMinimalUUPS.sol at commit b9e466c250744a7e06b13dff9d3c2844ed64f825, the
// source of the v2.0.0 registries deployed on Monad). Copyright the ERC-8004 authors,
// MIT-licensed per the SPDX header above. Used only to run XorvLedger's tests against the
// real registry logic behind ERC1967 proxies; never deployed by this package.
// See contracts/vendor/erc8004/README.md. Do not edit: re-vendor instead.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title HardhatMinimalUUPS
 * @dev Test version of MinimalUUPS that uses msg.sender as owner.
 * Used for hardhat tests to follow the proxy -> MinimalUUPS -> upgrade pattern.
 */
contract HardhatMinimalUUPS is OwnableUpgradeable, UUPSUpgradeable {
    /// @dev Identity registry address stored at slot 0 (matches real implementations)
    address private _identityRegistry;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address identityRegistry_) public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        _identityRegistry = identityRegistry_;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function getVersion() external pure returns (string memory) {
        return "0.0.1";
    }
}
