// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract ForceSend {
    receive() external payable {}

    function forceSend(address payable target) external {
        selfdestruct(target);
    }
}
