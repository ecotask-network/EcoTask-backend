export default {
  port: parseInt(process.env.PORT || "3000"),
  nodeEnv: process.env.NODE_ENV || "development",
  database: { url: process.env.DATABASE_URL || "postgresql://ecotask:ecotask@localhost:5432/ecotask" },
  redis: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  stellar: {
    network: process.env.STELLAR_NETWORK || "testnet",
    oracleSecretKey: process.env.STELLAR_ORACLE_SECRET_KEY || "",
    rewardEngineContractId: process.env.REWARD_ENGINE_CONTRACT_ID || "",
  },
  ipfs: { web3StorageToken: process.env.WEB3_STORAGE_TOKEN || "" },
  jwt: { secret: process.env.JWT_SECRET || "dev-secret-change-in-production", expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
};
