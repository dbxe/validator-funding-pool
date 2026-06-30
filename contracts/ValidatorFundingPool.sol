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
/// @notice Non-tokenized funding pool for one Ethereum validator with pool-owned 0x01 withdrawal credentials.
/// @dev The operator pays the 1 ETH predeposit first. Participants should fund the 31 ETH top-up only after
///      off-chain beacon-state verification confirms the committed pubkey is bound to this pool's withdrawal
///      credentials. The contract accounts for ETH that reaches the pool, but it does not verify BLS signatures,
///      beacon state, validator operation, priority-fee routing, or MEV routing.
contract ValidatorFundingPool {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 public constant VALIDATOR_DEPOSIT_WEI = 32 ether;
    uint256 public constant PREDEPOSIT_WEI = 1 ether;
    uint256 public constant TOP_UP_WEI = 31 ether;

    uint256 private constant MAX_PARTICIPANTS = 32;
    uint256 private constant PUBKEY_LENGTH = 48;
    uint256 private constant SIGNATURE_LENGTH = 96;
    bytes8 private constant FULL_EXIT_REQUEST_AMOUNT_DATA = bytes8(0);

    // -------------------------------------------------------------------------
    // State machine
    // -------------------------------------------------------------------------

    enum State {
        Uninitialized, // Validator data not committed; ordinary ETH is rejected.
        Predeposited, // 1 ETH validator predeposit submitted; no active funding attempt.
        Funding, // A fixed funding attempt is open for the remaining 31 ETH.
        ToppedUp // 31 ETH top-up submitted; pool proceeds are claimable pro rata.
    }

    // -------------------------------------------------------------------------
    // Immutable configuration
    // -------------------------------------------------------------------------

    address public immutable depositContract;
    address public immutable withdrawalRequestPredeploy;
    address public immutable operator;
    /// @notice Pool-owned 0x01 withdrawal credentials for the validator.
    bytes32 public immutable withdrawalCredentials;
    uint256 public immutable fundingWindowDuration;

    // -------------------------------------------------------------------------
    // Mutable lifecycle and accounting state
    // -------------------------------------------------------------------------

    State public state;
    uint256 public fundingAttempt;
    uint256 public fundingDeadline;

    uint256 public totalActiveFundedWei;
    /// @notice Outstanding refund liabilities from expired funding attempts.
    uint256 public totalRefundableWei;
    uint256 public totalRefundedWei;

    /// @notice Final economic weight credited after the validator top-up.
    uint256 public totalCreditedWei;
    /// @notice Cumulative pool proceeds already claimed.
    uint256 public totalClaimedWei;

    bool public predepositSubmitted;
    bool public topUpSubmitted;
    bytes32 public committedPubkeyHash;
    bytes32 public predepositDataRoot;
    bytes32 public topUpDepositDataRoot;

    uint256 public exitRequestAttemptCount;
    uint256 public lastExitRequestFeePaid;
    uint256 public lastExitRequestAt;

    // -------------------------------------------------------------------------
    // Participant and validator storage
    // -------------------------------------------------------------------------

    address[] private _participants;
    bytes private _committedPubkey;
    bytes private _predepositSignature;
    bytes private _topUpSignature;

    mapping(address participant => uint256 indexPlusOne) private _participantIndexPlusOne;
    /// @notice Final economic target for each participant in the active funding attempt.
    mapping(address participant => uint256 targetWei) public fundingTargetWeiOf;
    mapping(address participant => uint256 fundedWei) public activeFundedWeiOf;
    mapping(address participant => uint256 refundableWei) public refundableWeiOf;
    /// @notice Final credited economic weight for each participant after top-up.
    mapping(address participant => uint256 creditedWei) public creditedWeiOf;
    /// @notice Cumulative pool proceeds already claimed by each participant.
    mapping(address participant => uint256 claimedWei) public claimedWeiOf;

    uint256 private _reentrancyLock;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ValidatorPredeposited(
        bytes32 indexed pubkeyHash,
        bytes pubkey,
        bytes32 predepositDataRoot,
        bytes32 topUpDepositDataRoot
    );
    event FundingAttemptOpened(uint256 indexed attempt, uint256 fundingDeadline);
    event ParticipantFunded(
        uint256 indexed attempt,
        address indexed participant,
        uint256 amount,
        uint256 participantTotal,
        uint256 attemptTotal
    );
    event FundingAttemptClosed(uint256 indexed attempt);
    event Refunded(address indexed participant, address indexed recipient, uint256 amount);
    event ValidatorTopUpSubmitted(
        bytes32 indexed pubkeyHash,
        bytes pubkey,
        bytes32 topUpDepositDataRoot
    );
    event PoolToppedUp();
    event EthReceivedViaCall(address indexed sender, uint256 amount);
    /// @notice Post-action accounting snapshot for off-chain reconciliation.
    /// @dev Silent balance increases, including consensus withdrawals and forced ETH, may occur between snapshots.
    event AccountingSnapshot(
        State state,
        uint256 fundingAttempt,
        uint256 balance,
        uint256 totalActiveFundedWei,
        uint256 totalRefundableWei,
        uint256 totalRefundedWei,
        uint256 totalCreditedWei,
        uint256 totalClaimedWei,
        uint256 grossPoolProceeds
    );
    event Claimed(address indexed participant, address indexed recipient, uint256 amount);
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
    error OperatorTargetTooSmall();
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
    error InvalidPredepositValue();
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
        uint256 fundingWindowDuration_
    ) {
        if (depositContract_ == address(0) || depositContract_.code.length == 0) {
            revert InvalidDepositContract();
        }
        if (withdrawalRequestPredeploy_ == address(0) || withdrawalRequestPredeploy_.code.length == 0) {
            revert InvalidWithdrawalRequestPredeploy();
        }
        if (operator_ == address(0)) revert InvalidOperator();
        if (fundingWindowDuration_ == 0) revert InvalidFundingWindow();

        depositContract = depositContract_;
        withdrawalRequestPredeploy = withdrawalRequestPredeploy_;
        operator = operator_;
        fundingWindowDuration = fundingWindowDuration_;
        withdrawalCredentials = _makeEth1WithdrawalCredentials(address(this));
    }

    /// @notice Fund the current attempt when funding is open, or accept pool proceeds after top-up.
    /// @dev Ordinary ETH transfers are rejected before funding opens and after expired funding must be closed.
    receive() external payable {
        if (state == State.Funding) {
            _fund(msg.sender, msg.value);
            return;
        }

        if (state == State.ToppedUp) {
            emit EthReceivedViaCall(msg.sender, msg.value);
            _emitAccountingSnapshot();
            return;
        }

        revert InvalidState();
    }

    // -------------------------------------------------------------------------
    // Validator predeposit lifecycle
    // -------------------------------------------------------------------------

    /// @notice Commit validator deposit data and submit the operator-funded 1 ETH predeposit.
    /// @dev This contract only checks byte lengths and nonzero deposit roots. BLS signature, deposit root,
    ///      chain metadata, and beacon-state checks must be performed off-chain before participants fund.
    function commitAndPredeposit(
        bytes calldata pubkey,
        bytes calldata predepositSignature_,
        bytes32 predepositDataRoot_,
        bytes calldata topUpSignature_,
        bytes32 topUpDepositDataRoot_
    ) external payable onlyOperator nonReentrant {
        if (state != State.Uninitialized) revert InvalidState();
        if (msg.value != PREDEPOSIT_WEI) revert InvalidPredepositValue();
        _validateValidatorData(pubkey, predepositSignature_, predepositDataRoot_);
        _validateValidatorData(pubkey, topUpSignature_, topUpDepositDataRoot_);

        bytes32 pubkeyHash = keccak256(pubkey);
        committedPubkeyHash = pubkeyHash;
        predepositDataRoot = predepositDataRoot_;
        topUpDepositDataRoot = topUpDepositDataRoot_;
        _committedPubkey = pubkey;
        _predepositSignature = predepositSignature_;
        _topUpSignature = topUpSignature_;
        predepositSubmitted = true;

        IBeaconDepositContract(depositContract).deposit{value: PREDEPOSIT_WEI}(
            pubkey, abi.encodePacked(withdrawalCredentials), predepositSignature_, predepositDataRoot_
        );

        state = State.Predeposited;
        emit ValidatorPredeposited(pubkeyHash, pubkey, predepositDataRoot_, topUpDepositDataRoot_);
        _emitAccountingSnapshot();
    }

    /// @notice Open a fixed funding attempt for the remaining 31 ETH.
    /// @dev Targets are final economic weights, must sum to 32 ETH, and must include the operator with
    ///      at least the 1 ETH predeposit weight. Existing refund claims are kept separate.
    function openFundingAttempt(address[] calldata participants, uint256[] calldata fundingTargets)
        external
        onlyOperator
    {
        if (state != State.Predeposited) revert InvalidState();
        _setFundingAttempt(participants, fundingTargets);

        uint256 deadline = block.timestamp + fundingWindowDuration;
        fundingDeadline = deadline;
        fundingAttempt += 1;
        state = State.Funding;

        emit FundingAttemptOpened(fundingAttempt, deadline);
        _emitAccountingSnapshot();
    }

    function fund() external payable {
        _fund(msg.sender, msg.value);
    }

    /// @notice Close an expired funding attempt and convert active funding into refund claims.
    /// @dev Anyone may close after the deadline. Refund claims are independent liabilities and are not
    ///      automatically rolled into later funding attempts.
    function closeExpiredFundingAttempt() external {
        if (state != State.Funding) revert InvalidState();
        if (block.timestamp <= fundingDeadline) revert FundingStillOpen();

        uint256 count = _participants.length;
        for (uint256 i; i < count; ++i) {
            address participant = _participants[i];
            uint256 funded = activeFundedWeiOf[participant];
            if (funded != 0) {
                activeFundedWeiOf[participant] = 0;
                refundableWeiOf[participant] += funded;
                totalRefundableWei += funded;
            }
            fundingTargetWeiOf[participant] = 0;
            _participantIndexPlusOne[participant] = 0;
        }
        delete _participants;

        totalActiveFundedWei = 0;
        fundingDeadline = 0;
        state = State.Predeposited;

        emit FundingAttemptClosed(fundingAttempt);
        _emitAccountingSnapshot();
    }

    // -------------------------------------------------------------------------
    // Validator top-up lifecycle
    // -------------------------------------------------------------------------

    /// @notice Submit the 31 ETH top-up after exact active funding.
    /// @dev Final participant credits are fixed before the deposit call. After this succeeds, non-refund
    ///      ETH held by or later received by the pool is claimable pro rata by final credited weight.
    function topUpValidator() external onlyOperator nonReentrant {
        if (state != State.Funding) revert InvalidState();
        if (block.timestamp > fundingDeadline) revert FundingClosed();
        if (totalActiveFundedWei != TOP_UP_WEI) revert FundingIncomplete();
        if (address(this).balance < TOP_UP_WEI + totalRefundableWei) revert FundingIncomplete();
        if (topUpSubmitted) revert InvalidState();

        uint256 count = _participants.length;
        for (uint256 i; i < count; ++i) {
            address participant = _participants[i];
            uint256 credit = fundingTargetWeiOf[participant];
            creditedWeiOf[participant] = credit;
            totalCreditedWei += credit;
        }
        if (totalCreditedWei != VALIDATOR_DEPOSIT_WEI) revert FundingTargetsDoNotMatchValidator();

        topUpSubmitted = true;
        IBeaconDepositContract(depositContract).deposit{value: TOP_UP_WEI}(
            _committedPubkey, abi.encodePacked(withdrawalCredentials), _topUpSignature, topUpDepositDataRoot
        );

        state = State.ToppedUp;
        emit ValidatorTopUpSubmitted(committedPubkeyHash, _committedPubkey, topUpDepositDataRoot);
        emit PoolToppedUp();
        _emitAccountingSnapshot();
    }

    // -------------------------------------------------------------------------
    // Exit requests
    // -------------------------------------------------------------------------

    /// @notice Submit an EIP-7002 full-exit request attempt for the committed validator.
    /// @dev The caller pays the request fee directly. The operator may request exit after commitment;
    ///      final credited participants may request exit after top-up. Consensus processing can still ignore
    ///      an accepted request until validator-state preconditions are met, so retries are allowed.
    function requestExit(uint256 maxFee) external payable nonReentrant {
        if (_committedPubkey.length != PUBKEY_LENGTH) revert InvalidState();
        if (!_canRequestExit(msg.sender)) revert NotParticipant();

        uint256 fee = currentExitRequestFee();
        if (fee > maxFee) revert ExitFeeTooHigh(fee, maxFee);
        if (msg.value < fee) revert InsufficientExitFee(msg.value, fee);

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

    function refundTo(address payable recipient) public nonReentrant {
        _validateRecipient(recipient);

        uint256 amount = refundableWeiOf[msg.sender];
        if (amount == 0) revert NothingToRefund();

        refundableWeiOf[msg.sender] = 0;
        totalRefundableWei -= amount;
        totalRefundedWei += amount;
        _sendEth(recipient, amount);

        emit Refunded(msg.sender, recipient, amount);
        _emitAccountingSnapshot();
    }

    function claim() external {
        claimTo(payable(msg.sender));
    }

    function claimTo(address payable recipient) public nonReentrant {
        if (state != State.ToppedUp) revert InvalidState();
        _validateRecipient(recipient);

        uint256 amount = claimable(msg.sender);
        if (amount == 0) revert NothingToClaim();

        claimedWeiOf[msg.sender] += amount;
        totalClaimedWei += amount;
        _sendEth(recipient, amount);

        emit Claimed(msg.sender, recipient, amount);
        _emitAccountingSnapshot();
    }

    // -------------------------------------------------------------------------
    // Accounting views
    // -------------------------------------------------------------------------

    function claimable(address participant) public view returns (uint256) {
        if (state != State.ToppedUp) return 0;

        uint256 credit = creditedWeiOf[participant];
        if (credit == 0) return 0;

        uint256 entitled = grossPoolProceeds() * credit / totalCreditedWei;
        uint256 alreadyClaimed = claimedWeiOf[participant];
        if (entitled <= alreadyClaimed) return 0;
        return entitled - alreadyClaimed;
    }

    /// @notice Total pool proceeds used for cumulative pro-rata entitlement accounting.
    /// @dev Excludes outstanding refund liabilities and includes proceeds already claimed.
    function grossPoolProceeds() public view returns (uint256) {
        return address(this).balance + totalClaimedWei - totalRefundableWei;
    }

    /// @notice Remaining amount a participant may fund in the current attempt.
    /// @dev The operator's remaining amount subtracts the credited 1 ETH predeposit from its target.
    function fundingRemainingWeiOf(address participant) public view returns (uint256) {
        uint256 target = fundingTargetWeiOf[participant];
        if (target == 0) return 0;

        uint256 required = target;
        if (participant == operator) {
            required -= PREDEPOSIT_WEI;
        }

        uint256 funded = activeFundedWeiOf[participant];
        if (required <= funded) return 0;
        return required - funded;
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

    function predepositSignature() external view returns (bytes memory) {
        return _predepositSignature;
    }

    function topUpSignature() external view returns (bytes memory) {
        return _topUpSignature;
    }

    function withdrawalCredentialsBytes() external view returns (bytes memory) {
        return abi.encodePacked(withdrawalCredentials);
    }

    /// @notice Current EIP-7002 request fee reported by the withdrawal request predeploy.
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

        uint256 remaining = fundingRemainingWeiOf(participant);
        if (amount > remaining) revert FundingCapExceeded();

        uint256 newFunded = activeFundedWeiOf[participant] + amount;
        activeFundedWeiOf[participant] = newFunded;
        totalActiveFundedWei += amount;

        emit ParticipantFunded(fundingAttempt, participant, amount, newFunded, totalActiveFundedWei);
        _emitAccountingSnapshot();
    }

    function _setFundingAttempt(address[] calldata participants, uint256[] calldata fundingTargets) private {
        if (participants.length == 0) revert EmptyParticipantSet();
        if (participants.length > MAX_PARTICIPANTS) revert TooManyParticipants();
        if (participants.length != fundingTargets.length) revert InvalidFundingTarget();

        uint256 targetTotal;
        bool operatorSeen;
        for (uint256 i; i < participants.length; ++i) {
            address participant = participants[i];
            uint256 target = fundingTargets[i];
            if (participant == address(0)) revert InvalidParticipant();
            if (_isParticipant(participant)) revert DuplicateParticipant();
            if (target == 0) revert InvalidFundingTarget();

            if (participant == operator) {
                if (target < PREDEPOSIT_WEI) revert OperatorTargetTooSmall();
                operatorSeen = true;
            }

            _participantIndexPlusOne[participant] = i + 1;
            fundingTargetWeiOf[participant] = target;
            _participants.push(participant);
            targetTotal += target;
        }

        if (!operatorSeen) revert OperatorTargetTooSmall();
        if (targetTotal != VALIDATOR_DEPOSIT_WEI) revert FundingTargetsDoNotMatchValidator();
    }

    function _emitAccountingSnapshot() private {
        emit AccountingSnapshot(
            state,
            fundingAttempt,
            address(this).balance,
            totalActiveFundedWei,
            totalRefundableWei,
            totalRefundedWei,
            totalCreditedWei,
            totalClaimedWei,
            grossPoolProceeds()
        );
    }

    function _validateValidatorData(bytes calldata pubkey, bytes calldata signature, bytes32 depositDataRoot_)
        private
        pure
    {
        if (pubkey.length != PUBKEY_LENGTH) revert InvalidPubkey();
        if (signature.length != SIGNATURE_LENGTH) revert InvalidSignature();
        if (depositDataRoot_ == bytes32(0)) revert InvalidDepositDataRoot();
    }

    function _validateRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
    }

    function _sendEth(address payable recipient, uint256 amount) private {
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert EthPayoutFailed();
    }

    function _canRequestExit(address account) private view returns (bool) {
        return account == operator || creditedWeiOf[account] != 0;
    }

    function _isParticipant(address account) private view returns (bool) {
        return _participantIndexPlusOne[account] != 0;
    }

    function _makeEth1WithdrawalCredentials(address withdrawalAddress) private pure returns (bytes32) {
        return bytes32((uint256(0x01) << 248) | uint256(uint160(withdrawalAddress)));
    }
}
