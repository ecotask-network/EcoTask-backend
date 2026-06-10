import config from "../config/default.js";
import fs from "fs/promises";

export async function uploadToIPFS(filePath: string, filename: string): Promise<string> {
  if (!config.ipfs.web3StorageToken || config.ipfs.web3StorageToken === "mock") {
    const { randomUUID } = await import("crypto");
    return `mock-cid-${randomUUID()}`;
  }
  const { Web3Storage } = await import("web3.storage");
  const client = new Web3Storage({ token: config.ipfs.web3StorageToken });
  const fileBuffer = await fs.readFile(filePath);
  const file = new File([new Uint8Array(fileBuffer)], filename);
  const cid = await client.put([file], { wrapWithDirectory: false });
  return cid;
}

export async function uploadMultipleToIPFS(files: { path: string; name: string }[]): Promise<string[]> {
  if (!config.ipfs.web3StorageToken || config.ipfs.web3StorageToken === "mock") {
    const { randomUUID } = await import("crypto");
    return files.map(() => `mock-cid-${randomUUID()}`);
  }
  const { Web3Storage } = await import("web3.storage");
  const client = new Web3Storage({ token: config.ipfs.web3StorageToken });
  const uploads = await Promise.all(
    files.map(async (f) => {
      const buffer = await fs.readFile(f.path);
      return new File([new Uint8Array(buffer)], f.name);
    })
  );
  const cid = await client.put(uploads);
  return uploads.map(() => cid);
}
