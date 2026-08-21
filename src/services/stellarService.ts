import {
  Keypair,
  TransactionBuilder,
  Asset,
  Operation,
  Networks,
  BASE_FEE,
  Horizon,
  Memo,
} from '@stellar/stellar-sdk';
const Server = Horizon.Server;
import { randomBytes, randomUUID, createHash } from 'crypto';
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
  payoutId: string;
}

export async function submitReward(params: RewardParams): Promise<string> {
  const { userWallet, taskId, amount, assetCode, payoutId } = params;

  if (!config.stellar.oracleSecretKey || config.stellar.oracleSecretKey === 'mock') {
    logger.info('Mock Stellar reward', {
      amount: Number(amount) / 10000000,
      assetCode,
      userWallet,
      taskId,
      payoutId,
    });
    return `mock-tx-${payoutId}`;
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

  const payoutMemo = createHash('sha256').update(payoutId).digest('hex');

  let existingTx;
  try {
    const records = await server
      .transactions()
      .forAccount(userWallet)
      .order('desc')
      .limit(50)
      .call();
      
    existingTx = records.records.find((tx: any) => {
      if (tx.memo_type !== 'hash') return false;
      const memoHex = Buffer.from(tx.memo, 'base64').toString('hex');
      return tx.memo === payoutMemo || memoHex === payoutMemo;
    });
  } catch (err: any) {
    if (err.response && err.response.status === 404) {
      // Account not found, ignore
    } else {
      throw err;
    }
  }

  if (existingTx) {
    logger.info('Found existing transaction for payout', { payoutId, txHash: existingTx.hash });
    return existingTx.hash;
  }

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
    .addMemo(Memo.hash(payoutMemo))
    .setTimeout(30)
    .build();

  transaction.sign(oracleKeypair);
  const result = await server.submitTransaction(transaction);
  return result.hash;
}
