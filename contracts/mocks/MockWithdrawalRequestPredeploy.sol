// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockWithdrawalRequestPredeploy {
    uint256 public fee;
    uint256 public requestCount;
    address public lastSourceAddress;
    bytes public lastPubkey;
    bytes public lastAmountData;
    uint256 public lastValue;

    event WithdrawalRequestReceived(address indexed sourceAddress, bytes pubkey, bytes amountData, uint256 value);

    constructor(uint256 fee_) {
        fee = fee_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    fallback(bytes calldata input) external payable returns (bytes memory) {
        if (input.length == 0) {
            return abi.encode(fee);
        }

        require(input.length == 56, "bad request length");
        require(msg.value == fee, "bad fee");

        ++requestCount;
        lastSourceAddress = msg.sender;
        lastPubkey = input[:48];
        lastAmountData = input[48:56];
        lastValue = msg.value;

        emit WithdrawalRequestReceived(msg.sender, lastPubkey, lastAmountData, msg.value);
        return "";
    }
}
