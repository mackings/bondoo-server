import { config } from "../config.js";
import { UserModel } from "../models/user.js";

const PAYSTACK_BASE = "https://api.paystack.co";

export async function paystackPost(path: string, body: object) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.paystackSecretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? `Paystack error ${res.status}`);
  }
  return res.json() as Promise<any>;
}

export async function paystackGet(path: string) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    headers: { Authorization: `Bearer ${config.paystackSecretKey}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? `Paystack error ${res.status}`);
  }
  return res.json() as Promise<any>;
}

/**
 * Creates a Paystack customer + Dedicated Virtual Account for a user.
 * - Reuses existing paystackCustomerCode if already saved.
 * - Saves customerCode and virtualAccount to the user document on success.
 * - Returns true if DVA was created, false if Paystack rejected it
 *   (e.g. "Customer has not been identified" on accounts that require BVN first).
 */
export async function tryCreateDVA(user: any): Promise<boolean> {
  try {
    if (user.virtualAccount?.accountNumber) return true; // already has DVA

    const parts = (user.displayName ?? "").split(" ");
    const firstName = parts[0] || "User";
    const lastName  = parts.slice(1).join(" ") || firstName;

    // Step 1: Create or reuse Paystack customer
    let customerCode = user.paystackCustomerCode as string | undefined;
    if (!customerCode) {
      const customerResult = await paystackPost("/customer", {
        email:      user.email,
        first_name: firstName,
        last_name:  lastName,
        ...(user.phone ? { phone: user.phone } : {}),
      });
      customerCode = customerResult.data.customer_code as string;
      user.paystackCustomerCode = customerCode;
      await UserModel.findByIdAndUpdate(user._id, { paystackCustomerCode: customerCode });
    }

    // Step 2: Create Dedicated Virtual Account
    const dvaResult = await paystackPost("/dedicated_account", {
      customer:       customerCode,
      preferred_bank: "wema-bank",
    });

    const virtualAccount = {
      accountNumber: dvaResult.data.account_number as string,
      accountName:   dvaResult.data.account_name as string,
      bankName:      dvaResult.data.bank.name as string,
      bankSlug:      dvaResult.data.bank.slug as string,
      customerId:    customerCode,
    };

    user.virtualAccount = virtualAccount;
    await UserModel.findByIdAndUpdate(user._id, { virtualAccount });
    return true;
  } catch (err: any) {
    console.error("[tryCreateDVA] failed:", err.message);
    return false;
  }
}
