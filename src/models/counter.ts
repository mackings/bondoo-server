import mongoose, { Schema } from "mongoose";

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });
const CounterModel = mongoose.model("Counter", counterSchema);

/** Returns the next globally-unique integer for HD wallet address derivation. Atomic. */
export async function nextDepositIndex(): Promise<number> {
  const doc = await CounterModel.findByIdAndUpdate(
    "trade_deposit_index",
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return doc!.seq;
}
