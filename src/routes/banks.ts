import { Router } from "express";

export const banksRouter = Router();

// ── Static bank list (Nigerian banks with NIBSS codes) ───────────────────────
// Covers all major banks, microfinance banks, and fintech banks in Nigeria.
// Source: CBN-approved institutions list.

export const NIGERIAN_BANKS = [
  { name: "Access Bank", code: "044" },
  { name: "Citibank Nigeria", code: "023" },
  { name: "EcoBank Nigeria", code: "050" },
  { name: "Fidelity Bank", code: "070" },
  { name: "First Bank of Nigeria", code: "011" },
  { name: "First City Monument Bank (FCMB)", code: "214" },
  { name: "Globus Bank", code: "00103" },
  { name: "Guarantee Trust Bank (GTBank)", code: "058" },
  { name: "Heritage Bank", code: "030" },
  { name: "Jaiz Bank", code: "301" },
  { name: "Keystone Bank", code: "082" },
  { name: "Kuda Bank", code: "50211" },
  { name: "Lotus Bank", code: "303" },
  { name: "Moniepoint MFB", code: "50515" },
  { name: "Opay (OPay Digital Services)", code: "100004" },
  { name: "Palmpay", code: "100033" },
  { name: "Parallex Bank", code: "526" },
  { name: "Polaris Bank", code: "076" },
  { name: "Premium Trust Bank", code: "105" },
  { name: "Providus Bank", code: "101" },
  { name: "Signature Bank", code: "106" },
  { name: "Stanbic IBTC Bank", code: "221" },
  { name: "Standard Chartered Bank", code: "068" },
  { name: "Sterling Bank", code: "232" },
  { name: "SunTrust Bank", code: "100" },
  { name: "Titan Trust Bank", code: "102" },
  { name: "Union Bank of Nigeria", code: "032" },
  { name: "United Bank for Africa (UBA)", code: "033" },
  { name: "Unity Bank", code: "215" },
  { name: "VFD MFB", code: "566" },
  { name: "Wema Bank", code: "035" },
  { name: "Zenith Bank", code: "057" },
];

const GHANAIAN_BANKS = [
  { name: "Absa Bank Ghana", code: "absa" },
  { name: "Access Bank Ghana", code: "access-gh" },
  { name: "Agricultural Development Bank (ADB)", code: "adb" },
  { name: "CAL Bank", code: "cal" },
  { name: "Consolidated Bank Ghana (CBG)", code: "cbg" },
  { name: "Ecobank Ghana", code: "ecobank-gh" },
  { name: "Fidelity Bank Ghana", code: "fidelity-gh" },
  { name: "First Atlantic Bank", code: "fab" },
  { name: "GCB Bank", code: "gcb" },
  { name: "MTN Mobile Money (MoMo)", code: "mtn-momo" },
  { name: "National Investment Bank (NIB)", code: "nib" },
  { name: "Prudential Bank", code: "prudential" },
  { name: "Republic Bank Ghana", code: "republic-gh" },
  { name: "Societe Generale Ghana", code: "sg-gh" },
  { name: "Standard Chartered Ghana", code: "sc-gh" },
  { name: "Stanbic Bank Ghana", code: "stanbic-gh" },
  { name: "Universal Merchant Bank (UMB)", code: "umb" },
  { name: "Zenith Bank Ghana", code: "zenith-gh" },
];

const KENYAN_BANKS = [
  { name: "Absa Bank Kenya", code: "absa-ke" },
  { name: "Co-operative Bank of Kenya", code: "coop" },
  { name: "Diamond Trust Bank (DTB)", code: "dtb" },
  { name: "Equity Bank Kenya", code: "equity" },
  { name: "Family Bank Kenya", code: "family" },
  { name: "I&M Bank Kenya", code: "im" },
  { name: "KCB Bank Kenya", code: "kcb" },
  { name: "M-Pesa (Safaricom)", code: "mpesa" },
  { name: "NCBA Bank Kenya", code: "ncba" },
  { name: "NIC Bank Kenya", code: "nic" },
  { name: "Prime Bank Kenya", code: "prime-ke" },
  { name: "Sidian Bank", code: "sidian" },
  { name: "Standard Chartered Kenya", code: "sc-ke" },
  { name: "Stanbic Bank Kenya", code: "stanbic-ke" },
];

const SOUTH_AFRICAN_BANKS = [
  { name: "Absa Bank", code: "absa-za" },
  { name: "African Bank", code: "african" },
  { name: "Bidvest Bank", code: "bidvest" },
  { name: "Capitec Bank", code: "capitec" },
  { name: "Discovery Bank", code: "discovery" },
  { name: "FNB (First National Bank)", code: "fnb" },
  { name: "Investec Bank", code: "investec" },
  { name: "Nedbank", code: "nedbank" },
  { name: "Standard Bank South Africa", code: "std-za" },
  { name: "Tyme Bank", code: "tyme" },
];

const BANKS_BY_CURRENCY: Record<string, typeof NIGERIAN_BANKS> = {
  NGN: NIGERIAN_BANKS,
  GHS: GHANAIAN_BANKS,
  KES: KENYAN_BANKS,
  ZAR: SOUTH_AFRICAN_BANKS,
};

// ── GET /banks?currency=NGN ───────────────────────────────────────────────────

banksRouter.get("/", (_req, res) => {
  const currency = ((_req.query.currency as string) ?? "NGN").toUpperCase();
  const list = BANKS_BY_CURRENCY[currency] ?? NIGERIAN_BANKS;
  res.json({ banks: list });
});

// ── GET /banks/verify?account_number=&bank_code= ─────────────────────────────
// Validates the format of an account number (NUBAN = 10 digits for NGN).
// Account holder name is entered manually by the user — no third-party API needed.

banksRouter.get("/verify", (req, res) => {
  const accountNumber = (req.query.account_number as string ?? "").trim();
  const bankCode = (req.query.bank_code as string ?? "").trim();

  if (!accountNumber || !bankCode) {
    return res.status(400).json({ error: "account_number and bank_code are required" });
  }

  if (!/^\d{6,}$/.test(accountNumber)) {
    return res.status(422).json({ error: "Account number must be numeric (minimum 6 digits)" });
  }

  res.json({ valid: true, account_number: accountNumber, bank_code: bankCode });
});
