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

contract ValidatorFundingPool {
    enum State {
        Uninitialized,
        Funding,
        Staked,
        Canceled
    }

    uint256 public constant VALIDATOR_DEPOSIT_WEI = 32 ether;
    uint256 private constant MAX_PARTICIPANTS = 32;

    address public immutable depositContract;
    address public immutable withdrawalRequestPredeploy;
    address public immutable operator;
    bytes32 public immutable withdrawalCredentials;
    uint256 public immutable totalFundingTarget;
    uint256 public immutable fundingWindowDuration;

    State public state;
    uint256 public fundingDeadline;
    uint256 public totalFunded;
    uint256 public totalClaimed;
    uint256 public refundedTotal;
    uint256 public canceledSurplusTotalWeight;
    uint256 public canceledSurplusClaimedTotal;
    bool public validatorDeposited;
    uint256 public exitRequestCount;
    uint256 public lastExitRequestFee;
    uint256 public lastExitRequestTimestamp;
    bytes32 public validatorPubkeyHash;
    bytes32 public validatorDepositDataRoot;

    address[] private _participants;
    bytes private _validatorPubkey;
    bytes private _validatorSignature;

    mapping(address participant => uint256 indexPlusOne) private _participantIndexPlusOne;
    mapping(address participant => uint256 targetWei) public fundingTargetOf;
    mapping(address participant => uint256 fundedWei) public fundedOf;
    mapping(address participant => uint256 claimedWei) public claimedOf;
    mapping(address participant => uint256 surplusWeight) public canceledSurplusWeightOf;
    mapping(address participant => uint256 claimedWei) public canceledSurplusClaimedOf;

    uint256 private _reentrancyLock;

    event ParticipantFunded(address indexed participant, uint256 amount, uint256 participantTotal, uint256 poolTotal);
    event ValidatorCommitted(bytes32 indexed pubkeyHash, bytes pubkey, bytes32 depositDataRoot, uint256 fundingDeadline);
    event PoolCanceled(address indexed caller);
    event Refunded(address indexed participant, address indexed recipient, uint256 amount);
    event ValidatorDeposited(bytes32 indexed pubkeyHash, bytes pubkey, bytes32 depositDataRoot);
    event PoolStaked();
    event PoolProceedsReceived(address indexed sender, uint256 amount);
    event Claimed(address indexed participant, address indexed recipient, uint256 amount);
    event CanceledSurplusClaimed(address indexed participant, address indexed recipient, uint256 amount);
    event ExitRequested(bytes32 indexed pubkeyHash, bytes pubkey, uint256 feePaid, uint256 attempt);

    error EmptyParticipantSet();
    error TooManyParticipants();
    error InvalidParticipant();
    error DuplicateParticipant();
    error InvalidFundingTarget();
    error FundingTargetsDoNotMatchValidator();
    error InvalidDepositContract();
    error InvalidWithdrawalRequestPredeploy();
    error InvalidOperator();
    error InvalidValidatorConfig();
    error InvalidState();
    error FundingClosed();
    error FundingStillOpen();
    error NotOperator();
    error NotParticipant();
    error ZeroAmount();
    error FundingCapExceeded();
    error NotFullyFunded();
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
    error EthTransferFailed();

    modifier onlyParticipant() {
        if (_participantIndexPlusOne[msg.sender] == 0) revert NotParticipant();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock != 0) revert InvalidState();
        _reentrancyLock = 1;
        _;
        _reentrancyLock = 0;
    }

    constructor(
        address depositContract_,
        address withdrawalRequestPredeploy_,
        address operator_,
        uint256 fundingWindowDuration_,
        address[] memory participants_,
        uint256[] memory fundingTargets_
    ) {
        if (depositContract_ == address(0) || depositContract_.code.length == 0) revert InvalidDepositContract();
        if (withdrawalRequestPredeploy_ == address(0) || withdrawalRequestPredeploy_.code.length == 0) {
            revert InvalidWithdrawalRequestPredeploy();
        }
        if (operator_ == address(0)) revert InvalidOperator();
        if (fundingWindowDuration_ == 0) revert InvalidValidatorConfig();
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
            if (_participantIndexPlusOne[participant] != 0) revert DuplicateParticipant();
            if (target == 0) revert InvalidFundingTarget();

            _participantIndexPlusOne[participant] = i + 1;
            fundingTargetOf[participant] = target;
            _participants.push(participant);
            targetTotal += target;
        }

        if (targetTotal != VALIDATOR_DEPOSIT_WEI) revert FundingTargetsDoNotMatchValidator();
        totalFundingTarget = VALIDATOR_DEPOSIT_WEI;
    }

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

    function fund() external payable {
        _fund(msg.sender, msg.value);
    }

    function commitValidator(bytes calldata pubkey, bytes calldata signature, bytes32 depositDataRoot)
        external
        onlyOperator
    {
        if (state != State.Uninitialized) revert InvalidState();
        if (pubkey.length != 48) revert InvalidPubkey();
        if (signature.length != 96) revert InvalidSignature();
        if (depositDataRoot == bytes32(0)) revert InvalidDepositDataRoot();

        bytes32 pubkeyHash = keccak256(pubkey);
        validatorPubkeyHash = pubkeyHash;
        validatorDepositDataRoot = depositDataRoot;
        _validatorPubkey = pubkey;
        _validatorSignature = signature;

        uint256 deadline = block.timestamp + fundingWindowDuration;
        fundingDeadline = deadline;
        state = State.Funding;

        emit ValidatorCommitted(pubkeyHash, pubkey, depositDataRoot, deadline);
    }

    function cancel() external onlyParticipant {
        if (state != State.Funding) revert InvalidState();
        if (block.timestamp <= fundingDeadline) revert FundingStillOpen();

        state = State.Canceled;
        uint256 totalWeight = totalFunded == 0 ? totalFundingTarget : totalFunded;
        canceledSurplusTotalWeight = totalWeight;
        for (uint256 i; i < _participants.length; ++i) {
            address participant = _participants[i];
            uint256 weight = totalFunded == 0 ? fundingTargetOf[participant] : fundedOf[participant];
            canceledSurplusWeightOf[participant] = weight;
        }

        emit PoolCanceled(msg.sender);
    }

    function refund() external {
        refundTo(payable(msg.sender));
    }

    function refundTo(address payable recipient) public onlyParticipant nonReentrant {
        if (state != State.Canceled) revert InvalidState();
        _checkRecipient(recipient);

        uint256 amount = fundedOf[msg.sender];
        if (amount == 0) revert NothingToRefund();

        fundedOf[msg.sender] = 0;
        refundedTotal += amount;
        emit Refunded(msg.sender, recipient, amount);

        _sendEth(recipient, amount);
    }

    function stake() external onlyOperator nonReentrant {
        if (state != State.Funding) revert InvalidState();
        if (block.timestamp > fundingDeadline) revert FundingClosed();
        if (totalFunded != totalFundingTarget) revert NotFullyFunded();
        if (address(this).balance < totalFundingTarget) revert NotFullyFunded();
        if (validatorDeposited) revert InvalidState();

        bytes memory expectedWithdrawalCredentials = abi.encodePacked(withdrawalCredentials);
        validatorDeposited = true;

        IBeaconDepositContract(depositContract).deposit{value: VALIDATOR_DEPOSIT_WEI}(
            _validatorPubkey, expectedWithdrawalCredentials, _validatorSignature, validatorDepositDataRoot
        );

        emit ValidatorDeposited(validatorPubkeyHash, _validatorPubkey, validatorDepositDataRoot);

        state = State.Staked;
        emit PoolStaked();
    }

    function requestExit(uint256 maxFee) external payable onlyParticipant nonReentrant {
        if (state != State.Staked) revert InvalidState();

        uint256 fee = currentExitRequestFee();
        if (fee > maxFee) revert ExitFeeTooHigh(fee, maxFee);
        if (msg.value < fee) revert InsufficientExitFee(msg.value, fee);

        // EIP-7002 full exit requests use amount = 0, encoded as eight zero bytes.
        (bool ok,) = withdrawalRequestPredeploy.call{value: fee}(bytes.concat(_validatorPubkey, bytes8(0)));
        if (!ok) revert ExitRequestFailed();

        unchecked {
            ++exitRequestCount;
        }
        lastExitRequestFee = fee;
        lastExitRequestTimestamp = block.timestamp;

        uint256 refundAmount = msg.value - fee;
        if (refundAmount != 0) {
            _sendEth(payable(msg.sender), refundAmount);
        }

        emit ExitRequested(validatorPubkeyHash, _validatorPubkey, fee, exitRequestCount);
    }

    function claim() external {
        claimTo(payable(msg.sender));
    }

    function claimTo(address payable recipient) public onlyParticipant nonReentrant {
        if (state != State.Staked) revert InvalidState();
        _checkRecipient(recipient);

        uint256 amount = claimable(msg.sender);
        if (amount == 0) revert NothingToClaim();

        claimedOf[msg.sender] += amount;
        totalClaimed += amount;
        emit Claimed(msg.sender, recipient, amount);

        _sendEth(recipient, amount);
    }

    function sweepCanceledSurplus() external {
        sweepCanceledSurplusTo(payable(msg.sender));
    }

    function sweepCanceledSurplusTo(address payable recipient) public onlyParticipant nonReentrant {
        if (state != State.Canceled) revert InvalidState();
        _checkRecipient(recipient);

        uint256 amount = canceledSurplusClaimable(msg.sender);
        if (amount == 0) revert NothingToClaim();

        canceledSurplusClaimedOf[msg.sender] += amount;
        canceledSurplusClaimedTotal += amount;
        emit CanceledSurplusClaimed(msg.sender, recipient, amount);

        _sendEth(recipient, amount);
    }

    function claimable(address participant) public view returns (uint256) {
        if (state != State.Staked) return 0;

        uint256 funded = fundedOf[participant];
        if (funded == 0) return 0;

        uint256 entitled = grossPoolProceeds() * funded / totalFunded;
        uint256 alreadyClaimed = claimedOf[participant];
        if (entitled <= alreadyClaimed) return 0;
        return entitled - alreadyClaimed;
    }

    function grossPoolProceeds() public view returns (uint256) {
        return address(this).balance + totalClaimed;
    }

    function canceledSurplusClaimable(address participant) public view returns (uint256) {
        if (state != State.Canceled) return 0;

        uint256 weight = canceledSurplusWeightOf[participant];
        if (weight == 0) return 0;

        uint256 entitled = grossCanceledSurplus() * weight / canceledSurplusTotalWeight;
        uint256 alreadyClaimed = canceledSurplusClaimedOf[participant];
        if (entitled <= alreadyClaimed) return 0;
        return entitled - alreadyClaimed;
    }

    function grossCanceledSurplus() public view returns (uint256) {
        if (state != State.Canceled) return 0;

        uint256 outstandingRefunds = totalFunded - refundedTotal;
        return address(this).balance + canceledSurplusClaimedTotal - outstandingRefunds;
    }

    function isParticipant(address account) external view returns (bool) {
        return _participantIndexPlusOne[account] != 0;
    }

    function participantCount() external view returns (uint256) {
        return _participants.length;
    }

    function participantAt(uint256 index) external view returns (address) {
        return _participants[index];
    }

    function validatorPubkey() external view returns (bytes memory) {
        return _validatorPubkey;
    }

    function validatorSignature() external view returns (bytes memory) {
        return _validatorSignature;
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
        return exitRequestCount != 0;
    }

    function _fund(address participant, uint256 amount) private {
        if (state != State.Funding) revert InvalidState();
        if (block.timestamp > fundingDeadline) revert FundingClosed();
        if (_participantIndexPlusOne[participant] == 0) revert NotParticipant();
        if (amount == 0) revert ZeroAmount();

        uint256 funded = fundedOf[participant];
        uint256 target = fundingTargetOf[participant];
        if (amount > target - funded) revert FundingCapExceeded();

        uint256 newFunded = funded + amount;
        fundedOf[participant] = newFunded;
        totalFunded += amount;

        emit ParticipantFunded(participant, amount, newFunded, totalFunded);
    }

    function _sendEth(address payable to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    function _checkRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
    }

    function _makeEth1WithdrawalCredentials(address withdrawalAddress) private pure returns (bytes32) {
        return bytes32((uint256(0x01) << 248) | uint256(uint160(withdrawalAddress)));
    }
}
