import { Resend } from "resend";
import type { Delivery, Order } from "@/lib/types";

function client() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

function recipients(list: string | undefined): string[] {
  return (list || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

const FROM = () => process.env.EMAIL_FROM || "BSSP Order Tracker <onboarding@resend.dev>";

export async function sendDispatchCreatedEmail(order: Order, delivery: Delivery) {
  const to = recipients(process.env.NOTIFY_DISPATCH_EMAILS);
  const resend = client();
  if (!resend || to.length === 0) {
    console.warn("[email] Skipped dispatch-created email — Resend not configured or NOTIFY_DISPATCH_EMAILS is empty.");
    return;
  }

  const counts = delivery.dispatch?.counts ?? {};
  const rows = order.lines
    .filter((l) => counts[l.id] !== undefined)
    .map(
      (l) =>
        `<tr><td style="padding:4px 10px;">${l.partNo}</td><td style="padding:4px 10px;">${l.desc}</td><td style="padding:4px 10px;text-align:right;">${counts[l.id]}</td></tr>`
    )
    .join("");

  try {
    const { data, error } = await resend.emails.send({
      from: FROM(),
      to,
      subject: `New despatch created — ${order.orderNo} run ${String(delivery.runNo).padStart(2, "0")}`,
      html: `
        <h2 style="font-family:sans-serif;">New despatch — ${order.orderNo}</h2>
        <p style="font-family:sans-serif;">Run ${String(delivery.runNo).padStart(2, "0")} &middot; ${delivery.carrier} &middot; Docket ${delivery.docket}</p>
        <p style="font-family:sans-serif;">Counted by ${delivery.dispatch?.by ?? "—"}</p>
        <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:4px 10px;border-bottom:1px solid #ddd;">Part</th>
              <th style="text-align:left;padding:4px 10px;border-bottom:1px solid #ddd;">Description</th>
              <th style="text-align:right;padding:4px 10px;border-bottom:1px solid #ddd;">Qty packed</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `,
    });
    if (error) console.error("[email] Resend rejected dispatch-created email:", error.name, "-", error.message);
    else console.log("[email] Sent dispatch-created email, id:", data?.id);
  } catch (err) {
    console.error("[email] Failed to send dispatch-created email", err);
  }
}

export async function sendDiscrepancyEmail(order: Order, issues: string[]) {
  if (issues.length === 0) return;

  const to = recipients(process.env.NOTIFY_DISCREPANCY_EMAILS);
  const resend = client();
  if (!resend || to.length === 0) {
    console.warn("[email] Skipped discrepancy email — Resend not configured or NOTIFY_DISCREPANCY_EMAILS is empty.");
    return;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM(),
      to,
      subject: `Discrepancy flagged — ${order.orderNo}`,
      html: `
        <h2 style="font-family:sans-serif;">Discrepancy on ${order.orderNo}</h2>
        <ul style="font-family:sans-serif;font-size:13px;">
          ${issues.map((i) => `<li>${i}</li>`).join("")}
        </ul>
        <p style="font-family:sans-serif;font-size:12px;color:#666;">Open the master ledger in the order tracker for full detail.</p>
      `,
    });
    if (error) console.error("[email] Resend rejected discrepancy email:", error.name, "-", error.message);
    else console.log("[email] Sent discrepancy email, id:", data?.id);
  } catch (err) {
    console.error("[email] Failed to send discrepancy email", err);
  }
}
