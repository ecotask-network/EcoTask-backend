import { Keypair } from "@stellar/stellar-sdk";
import { randomBytes } from "crypto";

export function generateChallenge(): string {
  return randomBytes(32).toString("hex");
}

export function verifyStellarSignature(
  wallet: string,
  message: string,
  signature: string
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(wallet);
    return keypair.verify(Buffer.from(message), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}
