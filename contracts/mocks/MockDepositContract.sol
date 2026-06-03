// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockDepositContract {
    struct DepositRecord {
        bytes pubkey;
        bytes withdrawalCredentials;
        bytes signature;
        bytes32 depositDataRoot;
        uint256 amount;
    }

    DepositRecord[] private _deposits;

    event DepositReceived(
        bytes pubkey,
        bytes withdrawalCredentials,
        bytes signature,
        bytes32 depositDataRoot,
        uint256 amount
    );

    function deposit(
        bytes calldata pubkey,
        bytes calldata withdrawal_credentials,
        bytes calldata signature,
        bytes32 deposit_data_root
    ) external payable {
        require(pubkey.length == 48, "bad pubkey");
        require(withdrawal_credentials.length == 32, "bad withdrawal credentials");
        require(signature.length == 96, "bad signature");
        require(deposit_data_root != bytes32(0), "bad root");
        require(msg.value == 32 ether, "bad value");

        _deposits.push(
            DepositRecord({
                pubkey: pubkey,
                withdrawalCredentials: withdrawal_credentials,
                signature: signature,
                depositDataRoot: deposit_data_root,
                amount: msg.value
            })
        );

        emit DepositReceived(pubkey, withdrawal_credentials, signature, deposit_data_root, msg.value);
    }

    function depositCount() external view returns (uint256) {
        return _deposits.length;
    }

    function depositAt(uint256 index)
        external
        view
        returns (
            bytes memory pubkey,
            bytes memory withdrawalCredentials,
            bytes memory signature,
            bytes32 depositDataRoot,
            uint256 amount
        )
    {
        DepositRecord storage record = _deposits[index];
        return (
            record.pubkey,
            record.withdrawalCredentials,
            record.signature,
            record.depositDataRoot,
            record.amount
        );
    }
}
