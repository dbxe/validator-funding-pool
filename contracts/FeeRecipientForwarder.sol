// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Optional fixed-destination receiver for execution-layer validator rewards.
/// @dev The empty receive function is intentionally unconditional and must remain free of
///      state reads, writes, and events.
contract FeeRecipientForwarder {
    error InvalidPool();
    error InvalidPoolWithdrawalCredentials();
    error EmptyBalance();
    error SweepFailed();

    event Swept(address indexed caller, uint256 amount);

    address public immutable pool;

    constructor(address pool_) {
        if (pool_ == address(0) || pool_.code.length == 0) revert InvalidPool();

        (bool ok, bytes memory result) = pool_.staticcall(
            abi.encodeWithSignature("withdrawalCredentials()")
        );
        bytes32 expectedCredentials = bytes32(
            (uint256(1) << 248) | uint256(uint160(pool_))
        );
        if (
            !ok
                || result.length != 32
                || abi.decode(result, (bytes32)) != expectedCredentials
        ) {
            revert InvalidPoolWithdrawalCredentials();
        }

        pool = pool_;
    }

    receive() external payable {}

    /// @notice Send the entire pending balance to the immutable pool.
    function sweep() external {
        uint256 amount = address(this).balance;
        if (amount == 0) revert EmptyBalance();

        (bool ok,) = pool.call{value: amount}("");
        if (!ok) revert SweepFailed();

        emit Swept(msg.sender, amount);
    }
}
