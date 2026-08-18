import {
  Keypair,
  TransactionBuilder,
  Asset,
  Operation,
  Networks,
  BASE_FEE,
  Horizon,
} from '@stellar/stellar-sdk';
const Server = Horizon.Server;
import { randomBytes, randomUUID } from 'crypto';
import config from '../config/default';
import logger from '../utils/logger.js';

export function generateChallenge(): string {
  return randomBytes(32).toString('hex');
}

export function verifyStellarSignature(
  wallet: string,
  message: string,
  signature: string,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(wallet);
    return keypair.verify(Buffer.from(message), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

interface RewardParams {
  userWallet: string;
  taskId: string;
  amount: string;
  assetCode: string;
}

export async function submitReward(params: RewardParams): Promise<string> {
  const { userWallet, taskId, amount, assetCode } = params;

  if (!config.stellar.oracleSecretKey || config.stellar.oracleSecretKey === 'mock') {
    logger.info('Mock Stellar reward', {
      amount: Number(amount) / 10000000,
      assetCode,
      userWallet,
      taskId,
    });
    return `mock-tx-${randomUUID()}`;
  }

  const oracleKeypair = Keypair.fromSecret(config.stellar.oracleSecretKey);
  const server = new Server(
    config.stellar.network === 'testnet'
      ? 'https://horizon-testnet.stellar.org'
      : 'https://horizon.stellar.org',
  );

  const oracleAccount = await server.loadAccount(oracleKeypair.publicKey());
  const asset = new Asset(assetCode, oracleKeypair.publicKey());

  const m = BigInt(amount);
  const isNegative = m < 0n;
  const absMicros = isNegative ? -m : m;
  const integerPart = absMicros / 10000000n;
  const fractionalPart = absMicros % 10000000n;
  const sign = isNegative ? '-' : '';
  const decimalAmount = `${sign}${integerPart}.${fractionalPart.toString().padStart(7, '0')}`;

  const transaction = new TransactionBuilder(oracleAccount, {
    fee: BASE_FEE,
    networkPassphrase:
      config.stellar.network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC,
  })
    .addOperation(
      Operation.payment({
        destination: userWallet,
        asset,
        amount: decimalAmount,
      }),
    )
    .setTimeout(30)
    .build();

  transaction.sign(oracleKeypair);
  const result = await server.submitTransaction(transaction);
  return result.hash;
}
