import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import type { Delivery, Line, Order } from "@/lib/types";

function client() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

function envRecipients(list: string | undefined): string[] {
  return (list || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** DB-managed recipients (Setup tab) take priority; env vars are the fallback
    until someone's added there. */
async function resolveRecipients(kind: "dispatch" | "discrepancy"): Promise<string[]> {
  const field = kind === "dispatch" ? "notifyDispatch" : "notifyDiscrepancy";
  const rows = await prisma.notifyRecipient.findMany({ where: { [field]: true } });
  if (rows.length > 0) return rows.map((r) => r.email);
  return envRecipients(kind === "dispatch" ? process.env.NOTIFY_DISPATCH_EMAILS : process.env.NOTIFY_DISCREPANCY_EMAILS);
}

const FROM = () => process.env.EMAIL_FROM || "BSSP Order Tracker <onboarding@resend.dev>";

function lineRows(order: Order, counts: Record<string, number>): string {
  return order.lines
    .filter((l) => counts[l.id] !== undefined)
    .map(
      (l) =>
        `<tr><td style="padding:4px 10px;">${l.partNo}</td><td style="padding:4px 10px;">${l.desc}</td><td style="padding:4px 10px;text-align:right;">${counts[l.id]}</td></tr>`
    )
    .join("");
}

const tableHead = `
  <thead>
    <tr>
      <th style="text-align:left;padding:4px 10px;border-bottom:1px solid #ddd;">Part</th>
      <th style="text-align:left;padding:4px 10px;border-bottom:1px solid #ddd;">Description</th>
      <th style="text-align:right;padding:4px 10px;border-bottom:1px solid #ddd;">Qty packed</th>
    </tr>
  </thead>
`;

export async function sendDispatchCreatedEmail(order: Order, delivery: Delivery) {
  const to = await resolveRecipients("dispatch");
  const resend = client();
  if (!resend || to.length === 0) {
    console.warn("[email] Skipped dispatch-created email — Resend not configured or no dispatch recipients set.");
    return;
  }

  const rows = lineRows(order, delivery.dispatch?.counts ?? {});

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
          ${tableHead}
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

/** Same as sendDispatchCreatedEmail but for a dispatch that covers several
    orders on one truck run — one email, one section per order. */
export async function sendRunDispatchCreatedEmail(entries: { order: Order; delivery: Delivery }[]) {
  if (entries.length === 0) return;
  const to = await resolveRecipients("dispatch");
  const resend = client();
  if (!resend || to.length === 0) {
    console.warn("[email] Skipped dispatch-created email — Resend not configured or no dispatch recipients set.");
    return;
  }

  const { carrier, docket } = entries[0].delivery;
  const sections = entries
    .map(
      ({ order, delivery }) => `
        <h3 style="font-family:sans-serif;margin-bottom:2px;">${order.orderNo} — run ${String(delivery.runNo).padStart(2, "0")}</h3>
        <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;margin-bottom:16px;">
          ${tableHead}
          <tbody>${lineRows(order, delivery.dispatch?.counts ?? {})}</tbody>
        </table>
      `
    )
    .join("");

  try {
    const { data, error } = await resend.emails.send({
      from: FROM(),
      to,
      subject: `New despatch created — ${entries.map((e) => e.order.orderNo).join(", ")}`,
      html: `
        <h2 style="font-family:sans-serif;">New despatch — ${entries.length} orders</h2>
        <p style="font-family:sans-serif;">${carrier} &middot; Docket ${docket}</p>
        <p style="font-family:sans-serif;">Counted by ${entries[0].delivery.dispatch?.by ?? "—"}</p>
        ${sections}
      `,
    });
    if (error) console.error("[email] Resend rejected run dispatch-created email:", error.name, "-", error.message);
    else console.log("[email] Sent run dispatch-created email, id:", data?.id);
  } catch (err) {
    console.error("[email] Failed to send run dispatch-created email", err);
  }
}

export async function sendDiscrepancyEmail(order: Order, issues: string[]) {
  if (issues.length === 0) return;

  const to = await resolveRecipients("discrepancy");
  const resend = client();
  if (!resend || to.length === 0) {
    console.warn("[email] Skipped discrepancy email — Resend not configured or no discrepancy recipients set.");
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

export async function sendPoIncreaseRequestEmail(order: Order, line: Line, dispatched: number) {
  const to = await resolveRecipients("discrepancy");
  const resend = client();
  if (!resend || to.length === 0) {
    console.warn("[email] Skipped PO increase request email — Resend not configured or no discrepancy recipients set.");
    return;
  }

  const over = dispatched - line.qtyOrdered;

  try {
    const { data, error } = await resend.emails.send({
      from: FROM(),
      to,
      subject: `PO increase requested — ${order.orderNo} — ${line.partNo}`,
      html: `
        <h2 style="font-family:sans-serif;">PO increase requested — ${order.orderNo}</h2>
        <p style="font-family:sans-serif;font-size:13px;">
          ${line.partNo} (${line.desc}) — ordered ${line.qtyOrdered}, dispatched ${dispatched}
          (${over} over). Jason has requested the PO qty be increased to cover the extra supply.
        </p>
        <p style="font-family:sans-serif;font-size:12px;color:#666;">
          Update the ordered quantity on the DRC tab once agreed, or accept it as a no-charge
          over-supply instead if no PO change is needed.
        </p>
      `,
    });
    if (error) console.error("[email] Resend rejected PO increase request email:", error.name, "-", error.message);
    else console.log("[email] Sent PO increase request email, id:", data?.id);
  } catch (err) {
    console.error("[email] Failed to send PO increase request email", err);
  }
}
