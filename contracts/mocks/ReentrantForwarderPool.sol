// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IFeeRecipientForwarder {
    function sweep() external;
}

contract ReentrantForwarderPool {
    address public forwarder;
    uint256 public totalReceived;
    uint256 public reentryAttempts;

    function withdrawalCredentials() external view returns (bytes32) {
        return bytes32((uint256(1) << 248) | uint256(uint160(address(this))));
    }

    function setForwarder(address forwarder_) external {
        forwarder = forwarder_;
    }

    receive() external payable {
        totalReceived += msg.value;
        reentryAttempts += 1;
        try IFeeRecipientForwarder(forwarder).sweep() {} catch {}
    }
}
