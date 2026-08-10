// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Lolah Signal Proof Registry
/// @notice Anchors privacy-preserving batch commitments for Lolah intelligence and delivery receipts.
/// @dev Raw alerts, subscriber identities, positions, and trading instructions must never be stored here.
contract LolahSignalProofRegistry {
    error InvalidOperator();
    error InvalidBatch();
    error NotOperator();
    error NotPendingOperator();
    error SignalBatchAlreadyAnchored();
    error SignalBatchNotFound();
    error DeliveryBatchAlreadyAnchored();

    address public operator;
    address public pendingOperator;

    mapping(bytes32 root => uint64 anchoredAt) public signalBatchAnchoredAt;
    mapping(bytes32 root => uint64 anchoredAt) public deliveryBatchAnchoredAt;

    event SignalBatchAnchored(
        bytes32 indexed root,
        uint64 indexed windowStart,
        uint64 indexed windowEnd,
        uint32 signalCount,
        bytes32 releaseHash
    );
    event DeliveryBatchAnchored(
        bytes32 indexed root,
        bytes32 indexed signalBatchRoot,
        uint32 deliveryCount
    );
    event OperatorTransferProposed(address indexed currentOperator, address indexed pendingOperator);
    event OperatorTransferred(address indexed previousOperator, address indexed newOperator);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address initialOperator) {
        if (initialOperator == address(0)) revert InvalidOperator();
        operator = initialOperator;
    }

    function anchorSignalBatch(
        bytes32 root,
        uint64 windowStart,
        uint64 windowEnd,
        uint32 signalCount,
        bytes32 releaseHash
    ) external onlyOperator {
        if (
            root == bytes32(0)
                || releaseHash == bytes32(0)
                || signalCount == 0
                || windowStart > windowEnd
                || windowEnd > block.timestamp + 10 minutes
        ) revert InvalidBatch();
        if (signalBatchAnchoredAt[root] != 0) revert SignalBatchAlreadyAnchored();
        signalBatchAnchoredAt[root] = uint64(block.timestamp);
        emit SignalBatchAnchored(root, windowStart, windowEnd, signalCount, releaseHash);
    }

    function anchorDeliveryBatch(
        bytes32 root,
        bytes32 signalBatchRoot,
        uint32 deliveryCount
    ) external onlyOperator {
        if (root == bytes32(0) || deliveryCount == 0) revert InvalidBatch();
        if (signalBatchAnchoredAt[signalBatchRoot] == 0) revert SignalBatchNotFound();
        if (deliveryBatchAnchoredAt[root] != 0) revert DeliveryBatchAlreadyAnchored();
        deliveryBatchAnchoredAt[root] = uint64(block.timestamp);
        emit DeliveryBatchAnchored(root, signalBatchRoot, deliveryCount);
    }

    function proposeOperator(address nextOperator) external onlyOperator {
        if (nextOperator == address(0) || nextOperator == operator) revert InvalidOperator();
        pendingOperator = nextOperator;
        emit OperatorTransferProposed(operator, nextOperator);
    }

    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert NotPendingOperator();
        address previous = operator;
        operator = msg.sender;
        pendingOperator = address(0);
        emit OperatorTransferred(previous, msg.sender);
    }
}
