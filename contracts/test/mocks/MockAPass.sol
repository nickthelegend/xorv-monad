// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Stands in for Cleanverse's A-Pass: answers its validity view (selector 0xf480b6f5).
contract MockAPass {
    mapping(address => bool) public valid;

    function set(address account, bool isValid) external {
        valid[account] = isValid;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        require(bytes4(data[:4]) == 0xf480b6f5, "MockAPass: unknown selector");
        return abi.encode(valid[abi.decode(data[4:], (address))]);
    }
}

/// A compliance validator whose answer is set per account.
contract MockValidator {
    mapping(address => bool) public compliant;
    bool public reverts;

    function set(address account, bool ok) external {
        compliant[account] = ok;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function complianceVerify(address, address user) external view returns (bool) {
        require(!reverts, "PoolNotRegistered");
        return compliant[user];
    }
}
