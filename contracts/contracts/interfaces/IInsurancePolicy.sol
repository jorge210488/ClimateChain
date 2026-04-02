// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

/// @title IInsurancePolicy
/// @notice Interface for provider and oracle interactions with policy contracts.
/// @author ClimateChain
interface IInsurancePolicy {
  /// @notice Emitted whenever policy status transitions to a new lifecycle state.
  /// @param previousStatus Previous status encoded as uint8.
  /// @param newStatus New status encoded as uint8.
  /// @param transitionedAt Timestamp when transition was applied.
  event PolicyStatusTransitioned(
    uint8 indexed previousStatus,
    uint8 indexed newStatus,
    uint64 transitionedAt
  );

  /// @notice Emitted when policy is activated.
  /// @param insured Insured account address.
  /// @param premiumWei Activated premium amount.
  /// @param coverageWei Reserved coverage amount.
  event PolicyActivated(address indexed insured, uint256 premiumWei, uint256 coverageWei);

  /// @notice Emitted when provider requests weather update.
  /// @param policy Policy contract address.
  /// @param requestedAt Timestamp when request was emitted.
  event WeatherDataRequested(address indexed policy, uint64 requestedAt);

  /// @notice Emitted when oracle fulfills weather data.
  /// @param rainfallMm Rainfall value provided by oracle.
  /// @param conditionMet Whether trigger condition is met after update.
  /// @param updatedAt Timestamp when weather data was applied.
  event WeatherDataFulfilled(uint256 rainfallMm, bool conditionMet, uint64 updatedAt);

  /// @notice Emitted when payout is executed to insured.
  /// @param insured Insured account receiving payout.
  /// @param amountWei Coverage amount paid out.
  /// @param paidAt Timestamp when payout was executed.
  event PayoutExecuted(address indexed insured, uint256 amountWei, uint64 paidAt);

  /// @notice Emitted when policy expires without payout.
  /// @param insured Insured account linked to expired policy.
  /// @param expiredAt Timestamp when policy status became expired.
  event PolicyExpired(address indexed insured, uint64 expiredAt);

  /// @notice Activates policy with exact premium payment.
  function activate() external payable;

  /// @notice Requests weather data update while policy window is open.
  function requestWeatherData() external;

  /// @notice Pushes weather data into policy state.
  /// @param rainfallMm Observed rainfall amount in millimeters.
  function fulfillWeatherData(uint256 rainfallMm) external;

  /// @notice Executes payout when policy has been triggered.
  function executePayout() external;

  /// @notice Expires policy after policy window end.
  function expirePolicy() external;

  /// @notice Returns current ETH balance held by policy contract.
  /// @return Current on-chain balance in wei.
  function getCurrentBalance() external view returns (uint256);

  /// @notice Returns current policy status encoded as uint8.
  /// @return Current status value.
  function getStatus() external view returns (uint8);

  /// @notice Returns whether payout execution is currently allowed.
  /// @return True when policy is in Triggered status.
  function isPayoutEligible() external view returns (bool);

  /// @notice Returns whether expiry execution is currently allowed.
  /// @return True when policy is active and end timestamp has been reached.
  function isExpiryEligible() external view returns (bool);

  /// @notice Returns whether current timestamp is within weather request/fulfill window.
  /// @return True when current time is inside [startTimestamp, endTimestamp).
  function isWeatherWindowOpen() external view returns (bool);

  /// @notice Returns oracle address authorized to fulfill weather data.
  /// @return Oracle account address.
  function oracle() external view returns (address);

  /// @notice Returns insured account that receives payout on trigger.
  /// @return Insured account address.
  // solhint-disable-next-line use-natspec
  function insured() external view returns (address payable);

  /// @notice Indicates whether trigger condition has been met.
  /// @return True when rainfall threshold condition has been met.
  function conditionMet() external view returns (bool);

  /// @notice Returns policy premium amount.
  /// @return Premium amount in wei.
  function premiumWei() external view returns (uint256);

  /// @notice Returns policy coverage amount.
  /// @return Coverage amount in wei.
  function coverageWei() external view returns (uint256);

  /// @notice Returns rainfall trigger threshold configured for this policy.
  /// @return Trigger threshold in millimeters.
  function rainfallThresholdMm() external view returns (uint256);

  /// @notice Returns latest rainfall observed by oracle.
  /// @return Last fulfilled rainfall value in millimeters.
  function latestRainfallMm() external view returns (uint256);

  /// @notice Returns timestamp of latest oracle update.
  /// @return Last oracle update timestamp as unix seconds.
  function lastOracleUpdateTimestamp() external view returns (uint64);

  /// @notice Returns policy start timestamp.
  /// @return Start timestamp as unix seconds.
  function startTimestamp() external view returns (uint64);

  /// @notice Returns policy end timestamp.
  /// @return End timestamp as unix seconds.
  function endTimestamp() external view returns (uint64);
}
