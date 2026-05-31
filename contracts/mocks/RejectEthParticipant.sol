// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IValidatorFundingPool {
    function fund() external payable;
    function claim() external;
}

contract RejectEthParticipant {
    function fundPool(address pool) external payable {
        IValidatorFundingPool(pool).fund{value: msg.value}();
    }

    function claimPool(address pool) external {
        IValidatorFundingPool(pool).claim();
    }
}
