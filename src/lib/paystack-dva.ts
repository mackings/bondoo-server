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
 * Step 1: Create Paystack customer and persist the numeric id + customer_code.
 * Called at signup and email verification — NOT DVA creation yet.
 */
export async function createOrGetPaystackCustomer(
  user: any
): Promise<{ customerId: number; customerCode: string }> {
  if (user.paystackCustomerId && user.paystackCustomerCode) {
    return { customerId: user.paystackCustomerId, customerCode: user.paystackCustomerCode };
  }

  const parts = (user.displayName ?? "").split(" ");
  const firstName = parts[0] || "User";
  const lastName  = parts.slice(1).join(" ") || firstName;

  const result = await paystackPost("/customer", {
    email:      user.email,
    first_name: firstName,
    last_name:  lastName,
    ...(user.phone ? { phone: user.phone } : {}),
  });

  const customerId   = result.data.id as number;
  const customerCode = result.data.customer_code as string;

  await UserModel.findByIdAndUpdate(user._id, {
    paystackCustomerId:   customerId,
    paystackCustomerCode: customerCode,
  });
  user.paystackCustomerId   = customerId;
  user.paystackCustomerCode = customerCode;

  return { customerId, customerCode };
}

/**
 * Step 2: Create Dedicated Virtual Account for an already-identified customer.
 * Uses the numeric customer.id exactly as the Retilda pattern.
 * Returns true on success, false if Paystack rejects (e.g. not yet identified).
 */
export async function createDVA(user: any): Promise<boolean> {
  if (user.virtualAccount?.accountNumber) return true;

  const customerId = user.paystackCustomerId as number | undefined;
  if (!customerId) return false;

  try {
    const dvaResult = await paystackPost("/dedicated_account", {
      customer:       customerId,   // numeric id — same as Retilda's customer.id
      preferred_bank: "wema-bank",
    });

    const virtualAccount = {
      accountNumber: dvaResult.data.account_number as string,
      accountName:   dvaResult.data.account_name as string,
      bankName:      dvaResult.data.bank.name as string,
      bankSlug:      dvaResult.data.bank.slug as string,
      customerId:    user.paystackCustomerCode as string,
    };

    user.virtualAccount = virtualAccount;
    await UserModel.findByIdAndUpdate(user._id, { virtualAccount });
    return true;
  } catch (err: any) {
    console.error("[createDVA] failed:", err.message);
    return false;
  }
}
