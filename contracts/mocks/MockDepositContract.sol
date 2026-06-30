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
        require(msg.value >= 1 ether, "deposit value too low");
        require(msg.value % 1 gwei == 0, "deposit value not gwei");
        require(
            deposit_data_root == _computeDepositDataRoot(
                pubkey,
                withdrawal_credentials,
                signature,
                uint64(msg.value / 1 gwei)
            ),
            "bad deposit root"
        );

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

    function _computeDepositDataRoot(
        bytes calldata pubkey,
        bytes calldata withdrawalCredentials,
        bytes calldata signature,
        uint64 amountGwei
    ) private pure returns (bytes32) {
        bytes32 pubkeyRoot = sha256(abi.encodePacked(pubkey, bytes16(0)));
        bytes32 signatureRoot = sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(signature[:64])),
                sha256(abi.encodePacked(signature[64:], bytes32(0)))
            )
        );

        return sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(pubkeyRoot, withdrawalCredentials)),
                sha256(abi.encodePacked(_toLittleEndian64(amountGwei), bytes24(0), signatureRoot))
            )
        );
    }

    function _toLittleEndian64(uint64 value) private pure returns (bytes memory) {
        bytes memory encoded = new bytes(8);
        bytes8 bigEndian = bytes8(value);
        for (uint256 i; i < 8; ++i) {
            encoded[i] = bigEndian[7 - i];
        }
        return encoded;
    }
}
