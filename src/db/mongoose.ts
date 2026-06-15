import mongoose from "mongoose";
import { config } from "../config.js";

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(config.mongodbUri);
}
