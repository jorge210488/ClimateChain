import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const POLICY_STATUS = {
  Created: 0n,
  Active: 1n,
  Triggered: 2n,
  PaidOut: 3n,
  Expired: 4n,
} as const;

describe("InsuranceProvider", function () {
  async function deployFixture() {
    const [owner, insured, outsider] = await ethers.getSigners();

    const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
    const oracle = await oracleFactory.deploy(owner.address);
    await oracle.waitForDeployment();

    const providerFactory = await ethers.getContractFactory("InsuranceProvider");
    const provider = await providerFactory.deploy(owner.address, await oracle.getAddress());
    await provider.waitForDeployment();

    await provider.fundCoverageReserve({ value: ethers.parseEther("5") });

    return { owner, insured, outsider, oracle, provider };
  }

  async function deployUnactivatedPolicyFixture() {
    const [owner, insured] = await ethers.getSigners();

    const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
    const oracle = await oracleFactory.deploy(owner.address);
    await oracle.waitForDeployment();

    const policyFactory = await ethers.getContractFactory("InsurancePolicy");
    const startTimestamp = await time.latest();
    const endTimestamp = startTimestamp + 1;
    const coverage = ethers.parseEther("1.0");

    const policy = await policyFactory.deploy(
      owner.address,
      insured.address,
      await oracle.getAddress(),
      ethers.parseEther("0.10"),
      coverage,
      25,
      startTimestamp,
      endTimestamp,
      { value: coverage },
    );
    await policy.waitForDeployment();

    return { policy };
  }

  async function createPolicyForInsured(
    provider: Awaited<ReturnType<typeof deployFixture>>["provider"],
    insured: Awaited<ReturnType<typeof deployFixture>>["insured"],
    coverage: bigint,
    premium: bigint,
    threshold = 30,
    durationDays = 14,
  ) {
    await provider
      .connect(insured)
      .createPolicy(coverage, threshold, durationDays, { value: premium });

    const policies = await provider.getPoliciesByInsured(insured.address);
    const policyAddress = policies[policies.length - 1];
    const policy = await ethers.getContractAt("InsurancePolicy", policyAddress);

    return { policyAddress, policy };
  }

  it("creates and tracks policy by insured account", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");

    await expect(
      provider.connect(insured).createPolicy(coverage, 30, 14, { value: premium }),
    ).to.emit(provider, "PolicyCreated");

    const policies = await provider.getPoliciesByInsured(insured.address);
    expect(policies).to.have.length(1);

    const policy = await ethers.getContractAt("InsurancePolicy", policies[0]);

    expect(await policy.insured()).to.equal(insured.address);
    expect(await policy.status()).to.equal(POLICY_STATUS.Active);
    expect(await policy.premiumWei()).to.equal(premium);
    expect(await provider.coverageReserveWei()).to.equal(ethers.parseEther("4.0"));
    expect(await provider.premiumBalanceWei()).to.equal(0n);
  });

  it("executes payout after oracle threshold is met and books premium separately", async function () {
    const { owner, insured, oracle, provider } = await loadFixture(deployFixture);

    const premium = ethers.parseEther("0.15");
    const coverage = ethers.parseEther("1.5");
    const threshold = 50;

    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      threshold,
      20,
    );

    await oracle.pushWeatherData(policyAddress, threshold + 1);

    expect(await policy.conditionMet()).to.equal(true);
    expect(await policy.status()).to.equal(POLICY_STATUS.Triggered);

    const insuredBalanceBefore = await ethers.provider.getBalance(insured.address);

    const payoutTx = await provider.connect(owner).executePolicyPayout(policyAddress);
    await expect(payoutTx)
      .to.emit(provider, "PolicyPayoutExecuted")
      .withArgs(policyAddress, premium);
    await payoutTx.wait();

    const insuredBalanceAfter = await ethers.provider.getBalance(insured.address);

    expect(insuredBalanceAfter - insuredBalanceBefore).to.equal(coverage);
    expect(await policy.status()).to.equal(POLICY_STATUS.PaidOut);
    expect(await provider.coverageReserveWei()).to.equal(ethers.parseEther("3.5"));
    expect(await provider.premiumBalanceWei()).to.equal(ethers.parseEther("0.15"));
  });

  it("returns coverage to reserve and books premium separately when policy expires", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");

    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      25,
      1,
    );

    expect(await provider.coverageReserveWei()).to.equal(ethers.parseEther("4.0"));

    const endTimestamp = await policy.endTimestamp();
    await time.increaseTo(Number(endTimestamp));

    await expect(provider.expirePolicy(policyAddress))
      .to.emit(provider, "PolicyExpired")
      .withArgs(policyAddress, coverage, premium);

    expect(await policy.status()).to.equal(POLICY_STATUS.Expired);
    expect(await provider.coverageReserveWei()).to.equal(ethers.parseEther("5.0"));
    expect(await provider.premiumBalanceWei()).to.equal(ethers.parseEther("0.10"));
    expect(await policy.getCurrentBalance()).to.equal(0n);
  });

  it("rejects policy creation when premium is below minimum ratio", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    const coverage = ethers.parseEther("1.0");
    const premiumBelowMinimum = ethers.parseEther("0.009");

    await expect(
      provider.connect(insured).createPolicy(coverage, 20, 10, { value: premiumBelowMinimum }),
    ).to.be.revertedWithCustomError(provider, "PremiumBelowMinimum");
  });

  it("accepts policy creation at exact minimum premium ratio", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    const coverage = ethers.parseEther("1.0");
    const minimumPremium =
      (coverage * (await provider.MIN_PREMIUM_BPS()) +
        (await provider.BASIS_POINTS_DENOMINATOR()) -
        1n) /
      (await provider.BASIS_POINTS_DENOMINATOR());

    await expect(
      provider.connect(insured).createPolicy(coverage, 20, 10, { value: minimumPremium }),
    ).to.emit(provider, "PolicyCreated");
  });

  it("rejects policy creation when duration exceeds configured maximum", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    const coverage = ethers.parseEther("1.0");
    const premium = ethers.parseEther("0.10");
    const maxDurationDays = await provider.MAX_DURATION_DAYS();

    await expect(
      provider.connect(insured).createPolicy(coverage, 20, Number(maxDurationDays) + 1, {
        value: premium,
      }),
    ).to.be.revertedWithCustomError(provider, "DurationDaysExceedsMaximum");
  });

  it("accepts policy creation at exact max duration", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    const coverage = ethers.parseEther("1.0");
    const premium = ethers.parseEther("0.10");
    const maxDurationDays = await provider.MAX_DURATION_DAYS();

    await expect(
      provider.connect(insured).createPolicy(coverage, 20, Number(maxDurationDays), {
        value: premium,
      }),
    ).to.emit(provider, "PolicyCreated");
  });

  it("rejects zero-value reserve funding", async function () {
    const { provider } = await loadFixture(deployFixture);

    await expect(provider.fundCoverageReserve({ value: 0n })).to.be.revertedWithCustomError(
      provider,
      "InvalidCoverageAmount",
    );
  });

  it("withdraws coverage reserve and updates reserve balance", async function () {
    const { owner, provider } = await loadFixture(deployFixture);

    const withdrawAmount = ethers.parseEther("1.0");

    await expect(provider.withdrawCoverageReserve(withdrawAmount, owner.address))
      .to.emit(provider, "CoverageReserveWithdrawn")
      .withArgs(owner.address, withdrawAmount, ethers.parseEther("4.0"));

    expect(await provider.coverageReserveWei()).to.equal(ethers.parseEther("4.0"));
  });

  it("rejects coverage reserve withdrawal when amount exceeds reserve", async function () {
    const { owner, provider } = await loadFixture(deployFixture);

    await expect(
      provider.withdrawCoverageReserve(ethers.parseEther("6.0"), owner.address),
    ).to.be.revertedWithCustomError(provider, "InsufficientCoverageReserve");
  });

  it("rejects premium withdrawal when amount exceeds premium balance", async function () {
    const { owner, provider } = await loadFixture(deployFixture);

    await expect(provider.withdrawPremiumBalance(1n, owner.address)).to.be.revertedWithCustomError(
      provider,
      "InsufficientPremiumBalance",
    );
  });

  it("withdraws premium balance without affecting coverage reserve", async function () {
    const { owner, insured, oracle, provider } = await loadFixture(deployFixture);

    const premium = ethers.parseEther("0.20");
    const coverage = ethers.parseEther("1.0");
    const threshold = 15;

    const { policyAddress } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      threshold,
      10,
    );

    await oracle.pushWeatherData(policyAddress, threshold + 1);
    await provider.connect(owner).executePolicyPayout(policyAddress);

    const reserveBeforeWithdraw = await provider.coverageReserveWei();
    const insuredBalanceBefore = await ethers.provider.getBalance(insured.address);

    await provider.withdrawPremiumBalance(premium, insured.address);

    const insuredBalanceAfter = await ethers.provider.getBalance(insured.address);

    expect(insuredBalanceAfter - insuredBalanceBefore).to.equal(premium);
    expect(await provider.premiumBalanceWei()).to.equal(0n);
    expect(await provider.coverageReserveWei()).to.equal(reserveBeforeWithdraw);
  });

  it("withdraws untracked ETH without changing reserve or premium balances", async function () {
    const { owner, provider } = await loadFixture(deployFixture);

    const unexpectedWei = ethers.parseEther("0.25");
    await owner.sendTransaction({
      to: await provider.getAddress(),
      value: unexpectedWei,
    });

    expect(await provider.getUntrackedBalance()).to.equal(unexpectedWei);

    const reserveBeforeWithdraw = await provider.coverageReserveWei();
    const premiumBeforeWithdraw = await provider.premiumBalanceWei();

    await expect(provider.withdrawUntrackedBalance(unexpectedWei, owner.address))
      .to.emit(provider, "UntrackedBalanceWithdrawn")
      .withArgs(owner.address, unexpectedWei, 0n);

    expect(await provider.coverageReserveWei()).to.equal(reserveBeforeWithdraw);
    expect(await provider.premiumBalanceWei()).to.equal(premiumBeforeWithdraw);
    expect(await provider.getUntrackedBalance()).to.equal(0n);
  });

  it("rejects untracked ETH withdrawal above available amount", async function () {
    const { owner, provider } = await loadFixture(deployFixture);

    await expect(
      provider.withdrawUntrackedBalance(1n, owner.address),
    ).to.be.revertedWithCustomError(provider, "InsufficientUntrackedBalance");
  });

  it("rejects policy creation when reserve is insufficient", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    const premium = ethers.parseEther("0.2");
    const requestedCoverage = ethers.parseEther("9");

    await expect(
      provider.connect(insured).createPolicy(requestedCoverage, 20, 10, { value: premium }),
    ).to.be.revertedWithCustomError(provider, "InsufficientCoverageReserve");
  });

  it("returns descriptive reserve error for extremely large coverage requests", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    await expect(
      provider.connect(insured).createPolicy(ethers.MaxUint256, 20, 10, { value: 1n }),
    ).to.be.revertedWithCustomError(provider, "InsufficientCoverageReserve");
  });

  it("updates weather oracle and uses it for newly created policies", async function () {
    const { owner, insured, oracle, provider } = await loadFixture(deployFixture);

    const firstPolicy = await createPolicyForInsured(
      provider,
      insured,
      ethers.parseEther("1.0"),
      ethers.parseEther("0.10"),
      30,
      14,
    );

    const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
    const newOracle = await oracleFactory.deploy(owner.address);
    await newOracle.waitForDeployment();

    await expect(provider.setWeatherOracle(await newOracle.getAddress()))
      .to.emit(provider, "WeatherOracleUpdated")
      .withArgs(await oracle.getAddress(), await newOracle.getAddress(), false);

    const secondPolicy = await createPolicyForInsured(
      provider,
      insured,
      ethers.parseEther("0.5"),
      ethers.parseEther("0.05"),
      20,
      7,
    );

    expect(await firstPolicy.policy.oracle()).to.equal(await oracle.getAddress());
    expect(await secondPolicy.policy.oracle()).to.equal(await newOracle.getAddress());
  });

  it("rejects payout execution when policy is not triggered", async function () {
    const { owner, insured, provider } = await loadFixture(deployFixture);

    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      ethers.parseEther("1.0"),
      ethers.parseEther("0.10"),
      40,
      10,
    );

    await expect(provider.connect(owner).executePolicyPayout(policyAddress))
      .to.be.revertedWithCustomError(policy, "InvalidStatus")
      .withArgs(POLICY_STATUS.Triggered, POLICY_STATUS.Active);
  });

  it("rejects policy expiry through provider when policy is triggered", async function () {
    const { insured, oracle, provider } = await loadFixture(deployFixture);

    const threshold = 12;
    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      ethers.parseEther("1.0"),
      ethers.parseEther("0.10"),
      threshold,
      10,
    );

    await oracle.pushWeatherData(policyAddress, threshold + 1);

    await expect(provider.expirePolicy(policyAddress)).to.be.revertedWithCustomError(
      policy,
      "TriggeredPolicyRequiresPayout",
    );
  });

  it("rejects expiring a policy still in created status", async function () {
    const { policy } = await loadFixture(deployUnactivatedPolicyFixture);

    const endTimestamp = await policy.endTimestamp();
    await time.increaseTo(Number(endTimestamp) + 1);

    await expect(policy.expirePolicy())
      .to.be.revertedWithCustomError(policy, "InvalidStatus")
      .withArgs(POLICY_STATUS.Active, POLICY_STATUS.Created);
  });

  it("rejects duplicate payout attempts", async function () {
    const { owner, insured, oracle, provider } = await loadFixture(deployFixture);

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");
    const threshold = 10;

    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      threshold,
      10,
    );

    await oracle.pushWeatherData(policyAddress, threshold + 1);
    await provider.connect(owner).executePolicyPayout(policyAddress);

    await expect(
      provider.connect(owner).executePolicyPayout(policyAddress),
    ).to.be.revertedWithCustomError(provider, "PolicyAlreadySettledInProvider");
  });

  it("rejects unauthorized policy and oracle actions", async function () {
    const { insured, oracle, provider } = await loadFixture(deployFixture);

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");
    const { policyAddress } = await createPolicyForInsured(provider, insured, coverage, premium);

    await expect(
      provider.connect(insured).requestPolicyWeatherData(policyAddress),
    ).to.be.revertedWithCustomError(provider, "OwnableUnauthorizedAccount");

    await expect(
      oracle.connect(insured).pushWeatherData(policyAddress, 45),
    ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
  });

  it("rejects oracle pushes to non-policy addresses", async function () {
    const { insured, oracle } = await loadFixture(deployFixture);

    await expect(oracle.pushWeatherData(insured.address, 42)).to.be.revertedWithCustomError(
      oracle,
      "InvalidPolicyAddress",
    );
  });

  it("rejects oracle pushes from a different mock oracle instance", async function () {
    const { owner, insured, provider } = await loadFixture(deployFixture);

    const { policyAddress } = await createPolicyForInsured(
      provider,
      insured,
      ethers.parseEther("1.0"),
      ethers.parseEther("0.10"),
      25,
      7,
    );

    const oracleFactory = await ethers.getContractFactory("MockWeatherOracle");
    const foreignOracle = await oracleFactory.deploy(owner.address);
    await foreignOracle.waitForDeployment();

    await expect(foreignOracle.pushWeatherData(policyAddress, 40)).to.be.revertedWithCustomError(
      foreignOracle,
      "InvalidPolicyAddress",
    );
  });

  it("rejects weather updates and requests outside policy window", async function () {
    const { insured, oracle, provider } = await loadFixture(deployFixture);

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");
    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      15,
      1,
    );

    const endTimestamp = await policy.endTimestamp();
    await time.increaseTo(Number(endTimestamp));

    await expect(oracle.pushWeatherData(policyAddress, 50)).to.be.revertedWithCustomError(
      policy,
      "PolicyOutsideWeatherWindow",
    );

    await expect(provider.requestPolicyWeatherData(policyAddress)).to.be.revertedWithCustomError(
      policy,
      "PolicyOutsideWeatherWindow",
    );
  });

  it("rejects expiring a policy before end timestamp", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    const premium = ethers.parseEther("0.10");
    const coverage = ethers.parseEther("1.0");
    const { policyAddress, policy } = await createPolicyForInsured(
      provider,
      insured,
      coverage,
      premium,
      30,
      10,
    );

    await expect(provider.expirePolicy(policyAddress)).to.be.revertedWithCustomError(
      policy,
      "PolicyNotEnded",
    );
  });

  it("returns empty policy list for insured account with no policies", async function () {
    const { outsider, provider } = await loadFixture(deployFixture);

    expect(await provider.getPoliciesByInsured(outsider.address)).to.deep.equal([]);
  });

  it("tracks global policies count across multiple policy creations", async function () {
    const { insured, provider } = await loadFixture(deployFixture);

    await createPolicyForInsured(
      provider,
      insured,
      ethers.parseEther("1.0"),
      ethers.parseEther("0.10"),
      30,
      14,
    );
    await createPolicyForInsured(
      provider,
      insured,
      ethers.parseEther("0.5"),
      ethers.parseEther("0.05"),
      25,
      7,
    );

    expect(await provider.getAllPoliciesCount()).to.equal(2n);
  });

  it("rejects weather request on unknown policy", async function () {
    const { provider } = await loadFixture(deployFixture);

    await expect(
      provider.requestPolicyWeatherData(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(provider, "UnknownPolicyAddress");
  });

  it("rejects out-of-range policy index lookups", async function () {
    const { provider } = await loadFixture(deployFixture);

    await expect(provider.getPolicyAt(0)).to.be.revertedWithCustomError(
      provider,
      "PolicyIndexOutOfBounds",
    );
  });
});
