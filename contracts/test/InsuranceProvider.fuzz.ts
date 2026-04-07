import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

interface SeededRandom {
  state: number;
}

function nextRandom(random: SeededRandom): number {
  // LCG parameters from Numerical Recipes for deterministic pseudo-random sequences.
  random.state = (Math.imul(random.state, 1664525) + 1013904223) >>> 0;
  return random.state;
}

describe("InsuranceProvider fuzz", function () {
  async function deployFixture() {
    const [owner, insuredA, insuredB, insuredC] = await ethers.getSigners();

    const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
    const oracle = await oracleFactory.deploy(owner.address);
    await oracle.waitForDeployment();

    const providerFactory = await ethers.getContractFactory("InsuranceProvider");
    const provider = await providerFactory.deploy(owner.address, await oracle.getAddress());
    await provider.waitForDeployment();

    await oracle.setPolicyRegistry(await provider.getAddress());
    await provider.fundCoverageReserve({ value: ethers.parseEther("20") });

    return { owner, insuredA, insuredB, insuredC, oracle, provider };
  }

  it("preserves accounting invariants across deterministic fuzzed policy lifecycles", async function () {
    const { owner, insuredA, insuredB, insuredC, oracle, provider } =
      await loadFixture(deployFixture);

    const insuredSigners = [insuredA, insuredB, insuredC];
    const random: SeededRandom = { state: 0xc1a71c0d };

    for (let iteration = 0; iteration < 12; iteration += 1) {
      const coverageUnits = BigInt((nextRandom(random) % 13) + 2); // 0.2 to 1.4 ETH in 0.1 increments
      const coverageWei = coverageUnits * 10n ** 17n;
      const thresholdMm = (nextRandom(random) % 80) + 10;
      const durationDays = ((nextRandom(random) % 21) + 1) as number;
      const premiumMarginWei = BigInt((nextRandom(random) % 100) + 1);
      const insuredSigner = insuredSigners[nextRandom(random) % insuredSigners.length];
      const shouldSettleAsPayout = nextRandom(random) % 2 === 0;

      const minimumPremiumWei =
        (coverageWei * (await provider.MIN_PREMIUM_BPS()) +
          (await provider.BASIS_POINTS_DENOMINATOR()) -
          1n) /
        (await provider.BASIS_POINTS_DENOMINATOR());
      const premiumWei = minimumPremiumWei + premiumMarginWei;

      const currentTimestamp = await time.latest();
      const leadTimeSeconds = await provider.MIN_POLICY_START_LEAD_TIME_SECONDS();
      const requestedStartTimestamp = BigInt(currentTimestamp) + leadTimeSeconds + 5n;
      const regionCode = ethers.encodeBytes32String(`FZ${iteration}`);

      await provider
        .connect(insuredSigner)
        .createPolicyWithMetadata(
          coverageWei,
          thresholdMm,
          durationDays,
          regionCode,
          requestedStartTimestamp,
          { value: premiumWei },
        );

      const policies = await provider.getPoliciesByInsured(insuredSigner.address);
      const policyAddress = policies[policies.length - 1];
      const policy = await ethers.getContractAt("InsurancePolicy", policyAddress);

      const [storedRegionCode, storedRequestedStartTimestamp] =
        await provider.getPolicyMetadata(policyAddress);
      expect(storedRegionCode).to.equal(regionCode);
      expect(storedRequestedStartTimestamp).to.equal(requestedStartTimestamp);

      if (shouldSettleAsPayout) {
        const startTimestamp = await policy.startTimestamp();
        await time.increaseTo(Number(startTimestamp));

        await provider.connect(owner).requestPolicyWeatherData(policyAddress);
        await oracle.pushWeatherData(policyAddress, thresholdMm + 1);
        await provider.connect(owner).executePolicyPayout(policyAddress);

        const [settlementType] = await provider.getPolicySettlementInfo(policyAddress);
        expect(settlementType).to.equal(1n);
      } else {
        const endTimestamp = await policy.endTimestamp();
        await time.increaseTo(Number(endTimestamp));

        await provider.connect(owner).expirePolicy(policyAddress);

        const [settlementType] = await provider.getPolicySettlementInfo(policyAddress);
        expect(settlementType).to.equal(2n);
      }

      const reserveWei = await provider.coverageReserveWei();
      const premiumWeiInProvider = await provider.premiumBalanceWei();
      const trackedWei = await provider.getTrackedBalance();
      const deficitWei = await provider.getBalanceDeficit();

      expect(trackedWei).to.equal(reserveWei + premiumWeiInProvider);
      expect(deficitWei).to.equal(0n);
    }
  });
});
