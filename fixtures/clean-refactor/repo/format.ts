export interface Money { cents: number; currency: string }

const SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
};

export function formatMoney(m: Money): string {
  const symbol = SYMBOLS[m.currency] ?? "";
  const whole = Math.trunc(Math.abs(m.cents) / 100);
  const frac = Math.abs(m.cents) % 100;
  const sign = m.cents < 0 ? "-" : "";
  const suffix = symbol ? "" : ` ${m.currency}`;
  return `${sign}${symbol}${whole}.${String(frac).padStart(2, "0")}${suffix}`;
}

export function sum(items: Money[]): Money {
  if (items.length === 0) return { cents: 0, currency: "USD" };
  const currency = items[0]!.currency;
  for (const i of items) {
    if (i.currency !== currency) {
      throw new Error(`cannot sum ${currency} and ${i.currency}`);
    }
  }
  return { cents: items.reduce((a, i) => a + i.cents, 0), currency };
}
