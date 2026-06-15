import { FeeModel } from "../../models/fee.js";

export type FeeQuote = {
  platformFee: number;
  networkFee: number;
  payoutAmount: number;
};

export async function quoteFees(coin: string, network: string, amount: number): Promise<FeeQuote> {
  const fee = await FeeModel.findOne({ coin, network, active: true });
  const percentage = Number(fee?.get("percentageFee") ?? 0.02);
  const fixed = Number(fee?.get("fixedFee") ?? 0);
  const minimum = Number(fee?.get("minFee") ?? 0);
  const platformFee = Math.max(amount * percentage + fixed, minimum);
  const networkFee = 0;
  const payoutAmount = Math.max(amount - platformFee - networkFee, 0);

  return {
    platformFee: round8(platformFee),
    networkFee: round8(networkFee),
    payoutAmount: round8(payoutAmount),
  };
}

export async function seedDefaultFees() {
  const defaults = [
    { coin: "USDT", network: "TRC20", percentageFee: 0.02, fixedFee: 0, minFee: 1 },
    { coin: "USDT", network: "ERC20", percentageFee: 0.02, fixedFee: 0, minFee: 5 },
    { coin: "USDC", network: "ERC20", percentageFee: 0.02, fixedFee: 0, minFee: 5 },
    { coin: "BTC", network: "BTC", percentageFee: 0.02, fixedFee: 0, minFee: 0.0001 },
    { coin: "ETH", network: "ERC20", percentageFee: 0.02, fixedFee: 0, minFee: 0.002 },
  ];
  for (const fee of defaults) {
    await FeeModel.updateOne({ coin: fee.coin, network: fee.network }, { $setOnInsert: fee }, { upsert: true });
  }
}

function round8(value: number) {
  return Math.round(value * 100000000) / 100000000;
}
