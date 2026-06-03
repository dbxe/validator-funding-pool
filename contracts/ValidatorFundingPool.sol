// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IBeaconDepositContract {
    function deposit(
        bytes calldata pubkey,
        bytes calldata withdrawal_credentials,
        bytes calldata signature,
        bytes32 deposit_data_root
    ) external payable;
}

/// @title ValidatorFundingPool
/// @notice Non-tokenized 32 ETH validator funding pool for a fixed group of known participants.
/// @dev This contract is intentionally narrow:
///      - one validator;
///      - fixed participant set;
///      - no transferable claims;
///      - no admin rescue or arbitrary external-call path;
///      - no on-chain BLS proof-of-possession or beacon-state validation.
///
///      The operator is trusted for validator data validity, validator operation, slashing avoidance,
///      and EL priority fee / MEV recipient configuration. The contract only enforces custody and
///      pro-rata distribution of ETH that reaches this contract.
contract ValidatorFundingPool {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 public constant VALIDATOR_DEPOSIT_WEI = 32 ether;

    uint256 private constant MAX_PARTICIPANTS = 32;
    uint256 private constant PUBKEY_LENGTH = 48;
    uint256 private constant SIGNATURE_LENGTH = 96;
    bytes8 private constant FULL_EXIT_REQUEST_AMOUNT_DATA = bytes8(0);

    // -------------------------------------------------------------------------
    // State machine
    // -------------------------------------------------------------------------

    enum State {
        Uninitialized, // Validator data not committed; ordinary ETH is rejected.
        Funding, // Participants may fund; timeout cancellation is available.
        Staked, // Validator deposit submitted; ETH balance is pool proceeds.
        Canceled // Refunds and canceled-surplus sweeps only.
    }

    // -------------------------------------------------------------------------
    // Immutable configuration
    // -------------------------------------------------------------------------

    address public immutable depositContract;
    address public immutable withdrawalRequestPredeploy;
    address public immutable operator;
    bytes32 public immutable withdrawalCredentials;
    uint256 public immutable fundingTargetWei;
    uint256 public immutable fundingWindowDuration;

    // -------------------------------------------------------------------------
    // Mutable lifecycle and accounting state
    // -------------------------------------------------------------------------

    State public state;
    uint256 public fundingDeadline;

    uint256 public totalFundedWei;
    uint256 public totalClaimedWei;
    uint256 public totalRefundedWei;

    uint256 public canceledSurplusTotalWeight;
    uint256 public totalCanceledSurplusClaimedWei;

    bool public validatorDepositSubmitted;
    bytes32 public committedPubkeyHash;
    bytes32 public committedDepositDataRoot;

    uint256 public exitRequestAttemptCount;
    uint256 public lastExitRequestFeePaid;
    uint256 public lastExitRequestAt;

    // -------------------------------------------------------------------------
    // Participant and validator storage
    // -------------------------------------------------------------------------

    address[] private _participants;
    bytes private _committedPubkey;
    bytes private _committedSignature;

    mapping(address participant => uint256 indexPlusOne) private _participantIndexPlusOne;
    mapping(address participant => uint256 targetWei) public fundingTargetWeiOf;
    mapping(address participant => uint256 fundedWei) public fundedWeiOf;
    mapping(address participant => uint256 claimedWei) public claimedWeiOf;
    mapping(address participant => uint256 surplusWeight) public canceledSurplusWeightOf;
    mapping(address participant => uint256 claimedWei) public canceledSurplusClaimedWeiOf;

    uint256 private _reentrancyLock;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ValidatorCommitted(
        bytes32 indexed pubkeyHash,
        bytes pubkey,
        bytes32 depositDataRoot,
        uint256 fundingDeadline
    );
    event ParticipantFunded(
        address indexed participant,
        uint256 amount,
        uint256 participantTotal,
        uint256 poolTotal
    );
    event PoolCanceled(address indexed caller);
    event Refunded(address indexed participant, address indexed recipient, uint256 amount);
    event ValidatorDepositSubmitted(
        bytes32 indexed pubkeyHash,
        bytes pubkey,
        bytes32 depositDataRoot
    );
    event PoolStaked();
    event PoolProceedsReceived(address indexed sender, uint256 amount);
    event Claimed(address indexed participant, address indexed recipient, uint256 amount);
    event CanceledSurplusClaimed(
        address indexed participant,
        address indexed recipient,
        uint256 amount
    );
    event ExitRequestSubmitted(
        bytes32 indexed pubkeyHash,
        bytes pubkey,
        uint256 feePaid,
        uint256 attempt
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error EmptyParticipantSet();
    error TooManyParticipants();
    error InvalidParticipant();
    error DuplicateParticipant();
    error InvalidFundingTarget();
    error FundingTargetsDoNotMatchValidator();
    error InvalidDepositContract();
    error InvalidWithdrawalRequestPredeploy();
    error InvalidOperator();
    error InvalidFundingWindow();
    error InvalidState();
    error ReentrantCall();
    error FundingClosed();
    error FundingStillOpen();
    error NotOperator();
    error NotParticipant();
    error ZeroAmount();
    error FundingCapExceeded();
    error FundingIncomplete();
    error InvalidPubkey();
    error InvalidSignature();
    error InvalidDepositDataRoot();
    error ExitFeeReadFailed();
    error ExitFeeTooHigh(uint256 fee, uint256 maxFee);
    error InsufficientExitFee(uint256 provided, uint256 required);
    error ExitRequestFailed();
    error NothingToRefund();
    error NothingToClaim();
    error InvalidRecipient();
    error EthPayoutFailed();

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyParticipant() {
        if (!_isParticipant(msg.sender)) revert NotParticipant();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock != 0) revert ReentrantCall();
        _reentrancyLock = 1;
        _;
        _reentrancyLock = 0;
    }

    // -------------------------------------------------------------------------
    // Deployment
    // -------------------------------------------------------------------------

    constructor(
        address depositContract_,
        address withdrawalRequestPredeploy_,
        address operator_,
        uint256 fundingWindowDuration_,
        address[] memory participants_,
        uint256[] memory fundingTargets_
    ) {
        if (depositContract_ == address(0) || depositContract_.code.length == 0) {
            revert InvalidDepositContract();
        }
        if (withdrawalRequestPredeploy_ == address(0) || withdrawalRequestPredeploy_.code.length == 0) {
            revert InvalidWithdrawalRequestPredeploy();
        }
        if (operator_ == address(0)) revert InvalidOperator();
        if (fundingWindowDuration_ == 0) revert InvalidFundingWindow();
        if (participants_.length == 0) revert EmptyParticipantSet();
        if (participants_.length > MAX_PARTICIPANTS) revert TooManyParticipants();
        if (participants_.length != fundingTargets_.length) revert InvalidFundingTarget();

        depositContract = depositContract_;
        withdrawalRequestPredeploy = withdrawalRequestPredeploy_;
        operator = operator_;
        fundingWindowDuration = fundingWindowDuration_;
        withdrawalCredentials = _makeEth1WithdrawalCredentials(address(this));

        uint256 targetTotal;
        for (uint256 i; i < participants_.length; ++i) {
            address participant = participants_[i];
            uint256 target = fundingTargets_[i];
            if (participant == address(0)) revert InvalidParticipant();
            if (_isParticipant(participant)) revert DuplicateParticipant();
            if (target == 0) revert InvalidFundingTarget();

            _participantIndexPlusOne[participant] = i + 1;
            fundingTargetWeiOf[participant] = target;
            _participants.push(participant);
            targetTotal += target;
        }

        if (targetTotal != VALIDATOR_DEPOSIT_WEI) revert FundingTargetsDoNotMatchValidator();
        fundingTargetWei = VALIDATOR_DEPOSIT_WEI;
    }

    /// @notice Accept participant funding during Funding and pool proceeds during Staked.
    /// @dev Consensus withdrawals and forced ETH can change balance without invoking this function.
    receive() external payable {
        if (state == State.Funding) {
            _fund(msg.sender, msg.value);
            return;
        }

        if (state == State.Staked) {
            emit PoolProceedsReceived(msg.sender, msg.value);
            return;
        }

        revert InvalidState();
    }

    // -------------------------------------------------------------------------
    // Funding lifecycle
    // -------------------------------------------------------------------------

    /// @notice Commit validator deposit data before participant funding begins.
    function commitValidator(bytes calldata pubkey, bytes calldata signature, bytes32 depositDataRoot)
        external
        onlyOperator
    {
        if (state != State.Uninitialized) revert InvalidState();
        _validateValidatorData(pubkey, signature, depositDataRoot);

        bytes32 pubkeyHash = keccak256(pubkey);
        committedPubkeyHash = pubkeyHash;
        committedDepositDataRoot = depositDataRoot;
        _committedPubkey = pubkey;
        _committedSignature = signature;

        uint256 deadline = block.timestamp + fundingWindowDuration;
        fundingDeadline = deadline;
        state = State.Funding;

        emit ValidatorCommitted(pubkeyHash, pubkey, depositDataRoot, deadline);
    }

    function fund() external payable {
        _fund(msg.sender, msg.value);
    }

    function cancel() external onlyParticipant {
        if (state != State.Funding) revert InvalidState();
        if (block.timestamp <= fundingDeadline) revert FundingStillOpen();

        state = State.Canceled;

        uint256 totalWeight = totalFundedWei == 0 ? fundingTargetWei : totalFundedWei;
        canceledSurplusTotalWeight = totalWeight;
        for (uint256 i; i < _participants.length; ++i) {
            address participant = _participants[i];
            uint256 weight = totalFundedWei == 0 ? fundingTargetWeiOf[participant] : fundedWeiOf[participant];
            canceledSurplusWeightOf[participant] = weight;
        }

        emit PoolCanceled(msg.sender);
    }

    // -------------------------------------------------------------------------
    // Staking lifecycle
    // -------------------------------------------------------------------------

    function stake() external onlyOperator nonReentrant {
        if (state != State.Funding) revert InvalidState();
        if (block.timestamp > fundingDeadline) revert FundingClosed();
        if (totalFundedWei != fundingTargetWei) revert FundingIncomplete();
        if (address(this).balance < fundingTargetWei) revert FundingIncomplete();
        if (validatorDepositSubmitted) revert InvalidState();

        bytes memory expectedWithdrawalCredentials = abi.encodePacked(withdrawalCredentials);
        validatorDepositSubmitted = true;

        IBeaconDepositContract(depositContract).deposit{value: VALIDATOR_DEPOSIT_WEI}(
            _committedPubkey, expectedWithdrawalCredentials, _committedSignature, committedDepositDataRoot
        );

        emit ValidatorDepositSubmitted(committedPubkeyHash, _committedPubkey, committedDepositDataRoot);

        state = State.Staked;
        emit PoolStaked();
    }

    // -------------------------------------------------------------------------
    // Exit requests
    // -------------------------------------------------------------------------

    /// @notice Request a full validator exit through EIP-7002.
    /// @dev An EL-accepted request can still be ignored by CL processing, so retries are allowed.
    function requestExit(uint256 maxFee) external payable onlyParticipant nonReentrant {
        if (state != State.Staked) revert InvalidState();

        uint256 fee = currentExitRequestFee();
        if (fee > maxFee) revert ExitFeeTooHigh(fee, maxFee);
        if (msg.value < fee) revert InsufficientExitFee(msg.value, fee);

        // EIP-7002 full exit requests use amount = 0, encoded as eight zero bytes.
        bytes memory requestData = bytes.concat(_committedPubkey, FULL_EXIT_REQUEST_AMOUNT_DATA);
        (bool ok,) = withdrawalRequestPredeploy.call{value: fee}(requestData);
        if (!ok) revert ExitRequestFailed();

        exitRequestAttemptCount += 1;
        lastExitRequestFeePaid = fee;
        lastExitRequestAt = block.timestamp;

        uint256 refundAmount = msg.value - fee;
        if (refundAmount != 0) {
            _sendEth(payable(msg.sender), refundAmount);
        }

        emit ExitRequestSubmitted(committedPubkeyHash, _committedPubkey, fee, exitRequestAttemptCount);
    }

    // -------------------------------------------------------------------------
    // Payouts
    // -------------------------------------------------------------------------

    function refund() external {
        refundTo(payable(msg.sender));
    }

    function refundTo(address payable recipient) public onlyParticipant nonReentrant {
        if (state != State.Canceled) revert InvalidState();
        _validateRecipient(recipient);

        uint256 amount = fundedWeiOf[msg.sender];
        if (amount == 0) revert NothingToRefund();

        fundedWeiOf[msg.sender] = 0;
        totalRefundedWei += amount;
        emit Refunded(msg.sender, recipient, amount);

        _sendEth(recipient, amount);
    }

    function claim() external {
        claimTo(payable(msg.sender));
    }

    function claimTo(address payable recipient) public onlyParticipant nonReentrant {
        if (state != State.Staked) revert InvalidState();
        _validateRecipient(recipient);

        uint256 amount = claimable(msg.sender);
        if (amount == 0) revert NothingToClaim();

        claimedWeiOf[msg.sender] += amount;
        totalClaimedWei += amount;
        emit Claimed(msg.sender, recipient, amount);

        _sendEth(recipient, amount);
    }

    function sweepCanceledSurplus() external {
        sweepCanceledSurplusTo(payable(msg.sender));
    }

    function sweepCanceledSurplusTo(address payable recipient) public onlyParticipant nonReentrant {
        if (state != State.Canceled) revert InvalidState();
        _validateRecipient(recipient);

        uint256 amount = canceledSurplusClaimable(msg.sender);
        if (amount == 0) revert NothingToClaim();

        canceledSurplusClaimedWeiOf[msg.sender] += amount;
        totalCanceledSurplusClaimedWei += amount;
        emit CanceledSurplusClaimed(msg.sender, recipient, amount);

        _sendEth(recipient, amount);
    }

    // -------------------------------------------------------------------------
    // Accounting views
    // -------------------------------------------------------------------------

    function claimable(address participant) public view returns (uint256) {
        if (state != State.Staked) return 0;

        uint256 funded = fundedWeiOf[participant];
        if (funded == 0) return 0;

        // Gross proceeds includes already-claimed ETH, so claim order cannot affect entitlement.
        uint256 entitled = grossPoolProceeds() * funded / totalFundedWei;
        uint256 alreadyClaimed = claimedWeiOf[participant];
        if (entitled <= alreadyClaimed) return 0;
        return entitled - alreadyClaimed;
    }

    function grossPoolProceeds() public view returns (uint256) {
        return address(this).balance + totalClaimedWei;
    }

    function canceledSurplusClaimable(address participant) public view returns (uint256) {
        if (state != State.Canceled) return 0;

        uint256 weight = canceledSurplusWeightOf[participant];
        if (weight == 0) return 0;

        // Canceled surplus excludes outstanding refunds, so refund principal is never swept as surplus.
        uint256 entitled = grossCanceledSurplus() * weight / canceledSurplusTotalWeight;
        uint256 alreadyClaimed = canceledSurplusClaimedWeiOf[participant];
        if (entitled <= alreadyClaimed) return 0;
        return entitled - alreadyClaimed;
    }

    function grossCanceledSurplus() public view returns (uint256) {
        if (state != State.Canceled) return 0;

        uint256 outstandingRefunds = totalFundedWei - totalRefundedWei;
        return address(this).balance + totalCanceledSurplusClaimedWei - outstandingRefunds;
    }

    // -------------------------------------------------------------------------
    // Other views
    // -------------------------------------------------------------------------

    function isParticipant(address account) external view returns (bool) {
        return _isParticipant(account);
    }

    function participantCount() external view returns (uint256) {
        return _participants.length;
    }

    function participantAt(uint256 index) external view returns (address) {
        return _participants[index];
    }

    function committedPubkey() external view returns (bytes memory) {
        return _committedPubkey;
    }

    function committedSignature() external view returns (bytes memory) {
        return _committedSignature;
    }

    function withdrawalCredentialsBytes() external view returns (bytes memory) {
        return abi.encodePacked(withdrawalCredentials);
    }

    function currentExitRequestFee() public view returns (uint256) {
        (bool ok, bytes memory data) = withdrawalRequestPredeploy.staticcall("");
        if (!ok || data.length != 32) revert ExitFeeReadFailed();
        return abi.decode(data, (uint256));
    }

    function exitRequested() external view returns (bool) {
        return exitRequestAttemptCount != 0;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _fund(address participant, uint256 amount) private {
        if (state != State.Funding) revert InvalidState();
        if (block.timestamp > fundingDeadline) revert FundingClosed();
        if (!_isParticipant(participant)) revert NotParticipant();
        if (amount == 0) revert ZeroAmount();

        uint256 funded = fundedWeiOf[participant];
        uint256 target = fundingTargetWeiOf[participant];
        if (amount > target - funded) revert FundingCapExceeded();

        uint256 newFunded = funded + amount;
        fundedWeiOf[participant] = newFunded;
        totalFundedWei += amount;

        emit ParticipantFunded(participant, amount, newFunded, totalFundedWei);
    }

    function _validateValidatorData(bytes calldata pubkey, bytes calldata signature, bytes32 depositDataRoot)
        private
        pure
    {
        if (pubkey.length != PUBKEY_LENGTH) revert InvalidPubkey();
        if (signature.length != SIGNATURE_LENGTH) revert InvalidSignature();
        if (depositDataRoot == bytes32(0)) revert InvalidDepositDataRoot();
    }

    function _validateRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
    }

    function _sendEth(address payable recipient, uint256 amount) private {
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert EthPayoutFailed();
    }

    function _isParticipant(address account) private view returns (bool) {
        return _participantIndexPlusOne[account] != 0;
    }

    function _makeEth1WithdrawalCredentials(address withdrawalAddress) private pure returns (bytes32) {
        return bytes32((uint256(0x01) << 248) | uint256(uint160(withdrawalAddress)));
    }
}
