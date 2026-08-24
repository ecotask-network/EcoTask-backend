import config from '../config/default.js';
import fs from 'fs/promises';
import logger from '../utils/logger.js';

export async function uploadToIPFS(filePath: string, filename: string): Promise<string> {
  if (!config.ipfs.web3StorageToken || config.ipfs.web3StorageToken === 'mock') {
    const { randomUUID } = await import('crypto');
    return `mock-cid-${randomUUID()}`;
  }
  const { Web3Storage } = await import('web3.storage');
  const client = new Web3Storage({ token: config.ipfs.web3StorageToken });
  const fileBuffer = await fs.readFile(filePath);
  const file = new File([new Uint8Array(fileBuffer)], filename);
  const cid = await client.put([file], { wrapWithDirectory: false });
  return cid;
}

export async function uploadMultipleToIPFS(
  files: { path: string; name: string }[],
): Promise<string[]> {
  if (!config.ipfs.web3StorageToken || config.ipfs.web3StorageToken === 'mock') {
    const { randomUUID } = await import('crypto');
    return files.map(() => `mock-cid-${randomUUID()}`);
  }
  const { Web3Storage } = await import('web3.storage');
  const client = new Web3Storage({ token: config.ipfs.web3StorageToken });
  const uploads = await Promise.all(
    files.map(async (f) => {
      const buffer = await fs.readFile(f.path);
      return new File([new Uint8Array(buffer)], f.name);
    }),
  );
  const cid = await client.put(uploads);
  return uploads.map(() => cid);
}

/**
 * Best-effort reclamation of a CID that was uploaded to IPFS but never ended
 * up referenced by a committed proof (e.g. the DB transaction that would
 * have persisted it failed, or the photo batch it belonged to failed
 * partway through). In mock mode there is nothing to reclaim. In real mode
 * this drops the upload from the web3.storage account; it does not
 * guarantee immediate unpinning across the wider IPFS network (pinning
 * policy is out of scope here) — it only stops the app from durably
 * referencing content nothing in the DB points to. Cleanup is a courtesy,
 * not a guarantee: failures are logged and swallowed so they never mask the
 * original error that triggered the cleanup.
 */
export async function removeFromIPFS(cid: string): Promise<void> {
  if (!config.ipfs.web3StorageToken || config.ipfs.web3StorageToken === 'mock') {
    return;
  }
  try {
    const { Web3Storage } = await import('web3.storage');
    const client = new Web3Storage({ token: config.ipfs.web3StorageToken });
    await client.delete(cid);
  } catch (err) {
    logger.warn('Failed to remove orphaned CID from IPFS', { err, cid });
  }
}
