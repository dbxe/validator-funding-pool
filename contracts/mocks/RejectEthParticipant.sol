// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IValidatorFundingPool {
    function fund() external payable;
    function claim() external;
    function claimTo(address payable recipient) external;
    function refundTo(address payable recipient) external;
    function sweepCanceledSurplusTo(address payable recipient) external;
}

contract RejectEthParticipant {
    function fundPool(address pool) external payable {
        IValidatorFundingPool(pool).fund{value: msg.value}();
    }

    function claimPool(address pool) external {
        IValidatorFundingPool(pool).claim();
    }

    function claimPoolTo(address pool, address payable recipient) external {
        IValidatorFundingPool(pool).claimTo(recipient);
    }

    function refundPoolTo(address pool, address payable recipient) external {
        IValidatorFundingPool(pool).refundTo(recipient);
    }

    function sweepCanceledSurplusPoolTo(address pool, address payable recipient) external {
        IValidatorFundingPool(pool).sweepCanceledSurplusTo(recipient);
    }
}
