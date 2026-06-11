export async function notifyProofStatus(userId: string, proofId: string, status: string) {
  console.log(`[Notification] User ${userId}: Proof ${proofId} status → ${status}`);
}
