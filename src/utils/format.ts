const OCTAS_PER_APT = 100_000_000n;

export function octasToApt(octas: bigint): string {
  const whole = octas / OCTAS_PER_APT;
  const fraction = octas % OCTAS_PER_APT;
  const fractionStr = fraction.toString().padStart(8, "0").replace(/0+$/, "");
  return fractionStr ? `${whole}.${fractionStr}` : whole.toString();
}

export function timestampUsToDate(timestampUs: string): Date {
  return new Date(Number(BigInt(timestampUs) / 1000n));
}

export function timestampUsToISO(timestampUs: string): string {
  return timestampUsToDate(timestampUs).toISOString();
}
