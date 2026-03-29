import "dotenv/config";
import "@nomicfoundation/hardhat-toolbox";

import { HardhatUserConfig } from "hardhat/config";

const sepoliaRpcUrl = process.env.RPC_URL;
const deployerPrivateKey = process.env.PRIVATE_KEY;
const sepoliaChainId = Number(process.env.CHAIN_ID_SEPOLIA ?? "11155111");

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    ...(sepoliaRpcUrl && deployerPrivateKey
      ? {
          sepolia: {
            url: sepoliaRpcUrl,
            chainId: sepoliaChainId,
            accounts: [deployerPrivateKey],
          },
        }
      : {}),
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
