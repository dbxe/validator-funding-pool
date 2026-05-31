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
        Funding,
        Staked,
        Canceled
    }

    uint256 private constant GWEI = 1 gwei;
    uint256 private constant MAX_PARTICIPANTS = 32;

    address public immutable depositContract;
    address public immutable withdrawalRequestPredeploy;
    bytes32 public immutable withdrawalCredentials;
    uint256 public immutable validatorDepositWei;
    uint256 public immutable totalFundingTarget;
    uint256 public immutable fundingDeadline;

    State public state;
    uint256 public totalFunded;
    uint256 public totalClaimed;
    uint256 public refundedTotal;
    uint256 public canceledSurplusTotalWeight;
    uint256 public canceledSurplusClaimedTotal;
    bool public validatorDeposited;
    bool public exitRequested;
    bytes32 public validatorPubkeyHash;

    address[] private _participants;
    bytes private _validatorPubkey;

    mapping(address participant => uint256 indexPlusOne) private _participantIndexPlusOne;
    mapping(address participant => uint256 targetWei) public fundingTargetOf;
    mapping(address participant => uint256 fundedWei) public fundedOf;
    mapping(address participant => uint256 claimedWei) public claimedOf;
    mapping(address participant => uint256 surplusWeight) public canceledSurplusWeightOf;
    mapping(address participant => uint256 claimedWei) public canceledSurplusClaimedOf;

    uint256 private _reentrancyLock;

    event ParticipantFunded(address indexed participant, uint256 amount, uint256 participantTotal, uint256 poolTotal);
    event PoolCanceled(address indexed caller);
    event Refunded(address indexed participant, uint256 amount);
    event ValidatorDeposited(bytes indexed pubkey, bytes32 indexed pubkeyHash);
    event PoolStaked();
    event PoolProceedsReceived(address indexed sender, uint256 amount);
    event Claimed(address indexed participant, uint256 amount);
    event CanceledSurplusClaimed(address indexed participant, uint256 amount);
    event ExitRequested(bytes indexed pubkey, bytes32 indexed pubkeyHash, uint256 fee);

    error EmptyParticipantSet();
    error TooManyParticipants();
    error InvalidParticipant();
    error DuplicateParticipant();
    error InvalidFundingTarget();
    error FundingTargetsDoNotMatchValidator();
    error InvalidDepositContract();
    error InvalidWithdrawalRequestPredeploy();
    error InvalidValidatorConfig();
    error InvalidState();
    error FundingClosed();
    error FundingStillOpen();
    error NotParticipant();
    error ZeroAmount();
    error FundingCapExceeded();
    error NotFullyFunded();
    error InvalidPubkey();
    error InvalidSignature();
    error InvalidDepositDataRoot();
    error UnknownValidator();
    error ExitAlreadyRequested();
    error ExitFeeReadFailed();
    error ExitFeeTooHigh(uint256 fee, uint256 maxFee);
    error InsufficientExitFee(uint256 provided, uint256 required);
    error ExitRequestFailed();
    error NothingToRefund();
    error NothingToClaim();
    error EthTransferFailed();

    modifier onlyParticipant() {
        if (_participantIndexPlusOne[msg.sender] == 0) revert NotParticipant();
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
        uint256 validatorDepositWei_,
        uint256 fundingDeadline_,
        address[] memory participants_,
        uint256[] memory fundingTargets_
    ) {
        if (depositContract_ == address(0)) revert InvalidDepositContract();
        if (withdrawalRequestPredeploy_ == address(0)) revert InvalidWithdrawalRequestPredeploy();
        if (validatorDepositWei_ == 0 || validatorDepositWei_ % GWEI != 0 || fundingDeadline_ <= block.timestamp) {
            revert InvalidValidatorConfig();
        }
        if (participants_.length == 0) revert EmptyParticipantSet();
        if (participants_.length > MAX_PARTICIPANTS) revert TooManyParticipants();
        if (participants_.length != fundingTargets_.length) revert InvalidFundingTarget();

        depositContract = depositContract_;
        withdrawalRequestPredeploy = withdrawalRequestPredeploy_;
        validatorDepositWei = validatorDepositWei_;
        fundingDeadline = fundingDeadline_;
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

        if (targetTotal != validatorDepositWei_) revert FundingTargetsDoNotMatchValidator();
        totalFundingTarget = validatorDepositWei_;
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

    function refund() external nonReentrant {
        if (state != State.Canceled) revert InvalidState();

        uint256 amount = fundedOf[msg.sender];
        if (amount == 0) revert NothingToRefund();

        fundedOf[msg.sender] = 0;
        refundedTotal += amount;
        emit Refunded(msg.sender, amount);

        _sendEth(payable(msg.sender), amount);
    }

    function stake(bytes calldata pubkey, bytes calldata signature, bytes32 depositDataRoot) external nonReentrant {
        if (state != State.Funding) revert InvalidState();
        if (block.timestamp > fundingDeadline) revert FundingClosed();
        if (totalFunded != totalFundingTarget) revert NotFullyFunded();
        if (address(this).balance < totalFundingTarget) revert NotFullyFunded();
        if (validatorDeposited) revert InvalidState();
        if (pubkey.length != 48) revert InvalidPubkey();
        if (signature.length != 96) revert InvalidSignature();
        if (depositDataRoot == bytes32(0)) revert InvalidDepositDataRoot();

        bytes memory expectedWithdrawalCredentials = abi.encodePacked(withdrawalCredentials);
        bytes32 pubkeyHash = keccak256(pubkey);
        validatorDeposited = true;
        validatorPubkeyHash = pubkeyHash;
        _validatorPubkey = pubkey;

        IBeaconDepositContract(depositContract).deposit{value: validatorDepositWei}(
            pubkey, expectedWithdrawalCredentials, signature, depositDataRoot
        );

        emit ValidatorDeposited(pubkey, pubkeyHash);

        state = State.Staked;
        emit PoolStaked();
    }

    function requestExit(bytes calldata pubkey, uint256 maxFee) external payable onlyParticipant nonReentrant {
        if (state != State.Staked) revert InvalidState();
        if (pubkey.length != 48) revert InvalidPubkey();

        bytes32 pubkeyHash = keccak256(pubkey);
        if (!validatorDeposited || pubkeyHash != validatorPubkeyHash) revert UnknownValidator();
        if (exitRequested) revert ExitAlreadyRequested();

        uint256 fee = currentExitRequestFee();
        if (fee > maxFee) revert ExitFeeTooHigh(fee, maxFee);
        if (msg.value < fee) revert InsufficientExitFee(msg.value, fee);

        exitRequested = true;

        // EIP-7002 full exit requests use amount = 0, encoded as eight zero bytes.
        (bool ok,) = withdrawalRequestPredeploy.call{value: fee}(bytes.concat(pubkey, bytes8(0)));
        if (!ok) revert ExitRequestFailed();

        uint256 refundAmount = msg.value - fee;
        if (refundAmount != 0) {
            _sendEth(payable(msg.sender), refundAmount);
        }

        emit ExitRequested(pubkey, pubkeyHash, fee);
    }

    function claim() external nonReentrant {
        if (state != State.Staked) revert InvalidState();

        uint256 amount = claimable(msg.sender);
        if (amount == 0) revert NothingToClaim();

        claimedOf[msg.sender] += amount;
        totalClaimed += amount;
        emit Claimed(msg.sender, amount);

        _sendEth(payable(msg.sender), amount);
    }

    function sweepCanceledSurplus() external nonReentrant {
        if (state != State.Canceled) revert InvalidState();

        uint256 amount = canceledSurplusClaimable(msg.sender);
        if (amount == 0) revert NothingToClaim();

        canceledSurplusClaimedOf[msg.sender] += amount;
        canceledSurplusClaimedTotal += amount;
        emit CanceledSurplusClaimed(msg.sender, amount);

        _sendEth(payable(msg.sender), amount);
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

    function withdrawalCredentialsBytes() external view returns (bytes memory) {
        return abi.encodePacked(withdrawalCredentials);
    }

    function currentExitRequestFee() public view returns (uint256) {
        (bool ok, bytes memory data) = withdrawalRequestPredeploy.staticcall("");
        if (!ok || data.length != 32) revert ExitFeeReadFailed();
        return abi.decode(data, (uint256));
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

    function _makeEth1WithdrawalCredentials(address withdrawalAddress) private pure returns (bytes32) {
        return bytes32((uint256(0x01) << 248) | uint256(uint160(withdrawalAddress)));
    }
}
