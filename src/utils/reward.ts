const REWARD_SCALE = 10000000n;

export function formatRewardAmount(micros: bigint): string {
  const sign = micros < 0n ? '-' : '';
  const absoluteMicros = micros < 0n ? -micros : micros;
  const whole = absoluteMicros / REWARD_SCALE;
  const fraction = (absoluteMicros % REWARD_SCALE)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '');

  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}
