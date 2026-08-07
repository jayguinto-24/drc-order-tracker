"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { sendDiscrepancyEmail, sendDispatchCreatedEmail, sendOrderCreatedEmail, sendPoIncreaseRequestEmail, sendRunDispatchCreatedEmail } from "@/lib/email";
import { deliveryDeltas, lineReconciliation } from "@/lib/recon";
import type { CountMap, DraftLine, NotifyRecipient, Order, OrdersMap, Person, PersonRole } from "@/lib/types";
import type { Prisma } from "@/generated/prisma/client";

const orderInclude = {
  lines: true,
  deliveries: { orderBy: { runNo: "asc" } },
} satisfies Prisma.OrderInclude;

type DbOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

function toOrder(dbOrder: DbOrder): Order {
  return {
    orderNo: dbOrder.orderNo,
    status: dbOrder.status,
    orderDate: dbOrder.orderDate.toISOString().slice(0, 10),
    totalExGst: dbOrder.totalExGst,
    source: dbOrder.source,
    lines: dbOrder.lines.map((l) => ({
      id: l.id,
      partNo: l.partNo,
      desc: l.desc,
      colour: l.colour,
      qtyOrdered: l.qtyOrdered,
      jasonQty: l.jasonQty,
      overSupplyAccepted: l.overSupplyAccepted,
    })),
    deliveries: dbOrder.deliveries.map((d) => ({
      id: d.id,
      runNo: d.runNo,
      carrier: d.carrier,
      docket: d.docket,
      status: d.status,
      runId: d.runId,
      dispatch: d.dispatchCounts ? { by: d.dispatchBy ?? "", counts: d.dispatchCounts as CountMap } : null,
      receipt: d.receiptCounts ? { by: d.receiptBy ?? "", counts: d.receiptCounts as CountMap } : null,
    })),
  };
}

async function loadOrder(orderNo: string): Promise<Order> {
  const dbOrder = await prisma.order.findUniqueOrThrow({ where: { orderNo }, include: orderInclude });
  return toOrder(dbOrder);
}

export async function getOrders(): Promise<OrdersMap> {
  const dbOrders = await prisma.order.findMany({ include: orderInclude, orderBy: { createdAt: "asc" } });
  const map: OrdersMap = {};
  dbOrders.forEach((o) => {
    map[o.orderNo] = toOrder(o);
  });
  return map;
}

async function createOrder(orderNo: string, source: string, lines: { partNo: string; desc: string; colour: string; qtyOrdered: number }[]): Promise<Order> {
  const trimmed = orderNo.trim();
  if (!trimmed) throw new Error("Order number is required.");
  if (lines.length === 0) throw new Error("At least one line with a part number and quantity is required.");

  try {
    const dbOrder = await prisma.order.create({
      data: {
        orderNo: trimmed,
        status: "open",
        source,
        lines: { create: lines },
      },
      include: orderInclude,
    });
    const created = toOrder(dbOrder);
    await sendOrderCreatedEmail(created);
    revalidatePath("/");
    return created;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      throw new Error(`Order ${trimmed} already exists.`);
    }
    throw err;
  }
}

export async function createManualOrder(orderNo: string, draftLines: DraftLine[]): Promise<Order> {
  const lines = draftLines
    .filter((l) => l.partNo.trim() && l.qty.trim())
    .map((l) => ({ partNo: l.partNo, desc: l.desc, colour: l.colour || "—", qtyOrdered: Number(l.qty) }));
  return createOrder(orderNo, "manual", lines);
}

export async function createImportOrder(
  orderNo: string,
  lines: { partNo: string; desc: string; colour: string; qtyOrdered: number }[]
): Promise<Order> {
  return createOrder(orderNo, "excel_import", lines);
}

export async function updateLineQty(orderNo: string, lineId: string, qty: number): Promise<Order> {
  if (!Number.isFinite(qty) || qty < 0) throw new Error("Quantity must be a non-negative number.");
  await prisma.line.update({ where: { id: lineId }, data: { qtyOrdered: qty } });
  revalidatePath("/");
  return loadOrder(orderNo);
}

export async function updateJasonQty(orderNo: string, lineId: string, qty: number | null): Promise<Order> {
  await prisma.line.update({ where: { id: lineId }, data: { jasonQty: qty } });
  revalidatePath("/");
  return loadOrder(orderNo);
}

export async function acceptOverSupply(orderNo: string, lineId: string): Promise<Order> {
  await prisma.line.update({ where: { id: lineId }, data: { overSupplyAccepted: true } });
  revalidatePath("/");
  return loadOrder(orderNo);
}

export async function requestPoIncrease(orderNo: string, lineId: string): Promise<Order> {
  const order = await loadOrder(orderNo);
  const line = order.lines.find((l) => l.id === lineId);
  if (!line) throw new Error("Line not found.");
  const recon = lineReconciliation(order).find((l) => l.id === lineId);
  await sendPoIncreaseRequestEmail(order, line, recon?.dispatched ?? 0);
  return order;
}

/* ------------------------- Dispatch / receipt — Runs --------------------------- */
/* A Run groups the deliveries created together in one packing session, whether
   that's one order (the common case) or several orders dispatched on the same
   truck. Single-order helpers below are thin wrappers so existing callers don't
   need to change. */

export async function startRun(orderNos: string[], carrier: string, docket: string): Promise<Order[]> {
  const uniqueOrderNos = Array.from(new Set(orderNos));
  if (uniqueOrderNos.length === 0) throw new Error("Select at least one order.");

  const run = await prisma.run.create({ data: {} });
  for (const orderNo of uniqueOrderNos) {
    const order = await prisma.order.findUniqueOrThrow({ where: { orderNo }, include: { deliveries: true } });
    const nextRun = order.deliveries.length + 1;
    await prisma.delivery.create({
      data: { orderId: order.id, runId: run.id, runNo: nextRun, carrier: carrier || "—", docket: docket || "—", status: "draft" },
    });
  }
  revalidatePath("/");
  return Promise.all(uniqueOrderNos.map((no) => loadOrder(no)));
}

export async function startDelivery(orderNo: string, carrier: string, docket: string): Promise<Order> {
  const [order] = await startRun([orderNo], carrier, docket);
  return order;
}

type RunEntry = { orderNo: string; deliveryId: string; counts: CountMap };

export async function submitRunDispatch(entries: RunEntry[], by: string): Promise<Order[]> {
  if (entries.length === 0) throw new Error("Nothing to submit.");

  for (const e of entries) {
    await prisma.delivery.update({
      where: { id: e.deliveryId },
      data: { status: "dispatched", dispatchBy: by, dispatchCounts: e.counts },
    });
  }

  const orders = await Promise.all(entries.map((e) => loadOrder(e.orderNo)));
  const withDelivery = entries.map((e, i) => {
    const order = orders[i];
    const delivery = order.deliveries.find((d) => d.id === e.deliveryId);
    if (!delivery) throw new Error("Delivery not found after update.");
    return { order, delivery };
  });

  if (withDelivery.length === 1) {
    await sendDispatchCreatedEmail(withDelivery[0].order, withDelivery[0].delivery);
  } else {
    await sendRunDispatchCreatedEmail(withDelivery);
  }

  for (const { order, delivery } of withDelivery) {
    const touchedIds = new Set(Object.keys(delivery.dispatch?.counts ?? {}));
    const recon = lineReconciliation(order);
    const overPacked = recon
      .filter((l) => touchedIds.has(l.id) && l.backOrder < 0 && !l.overSupplyAccepted)
      .map((l) => `${l.partNo} — run ${String(delivery.runNo).padStart(2, "0")}: ${Math.abs(l.backOrder)} more dispatched than ordered.`);
    await sendDiscrepancyEmail(order, overPacked);
  }

  revalidatePath("/");
  return orders;
}

export async function submitDispatch(orderNo: string, deliveryId: string, by: string, counts: CountMap): Promise<Order> {
  const [order] = await submitRunDispatch([{ orderNo, deliveryId, counts }], by);
  return order;
}

export async function submitRunReceipt(entries: RunEntry[], by: string): Promise<Order[]> {
  if (entries.length === 0) throw new Error("Nothing to submit.");

  for (const e of entries) {
    await prisma.delivery.update({
      where: { id: e.deliveryId },
      data: { status: "received", receiptBy: by, receiptCounts: e.counts },
    });
  }

  const orders = await Promise.all(entries.map((e) => loadOrder(e.orderNo)));

  for (let i = 0; i < entries.length; i++) {
    const order = orders[i];
    const delivery = order.deliveries.find((d) => d.id === entries[i].deliveryId);
    if (!delivery) throw new Error("Delivery not found after update.");

    const issues: string[] = [];
    order.lines.forEach((l) => {
      deliveryDeltas(order, l.id)
        .filter((d) => d.runNo === delivery.runNo && d.delta !== null && d.delta !== 0)
        .forEach((d) => {
          const desc = (d.delta ?? 0) > 0 ? `${d.delta} missing` : `${Math.abs(d.delta ?? 0)} extra`;
          issues.push(`${l.partNo} — run ${String(d.runNo).padStart(2, "0")} (${d.carrier}): sent ${d.sent}, received ${d.got}, ${desc}.`);
        });
    });
    await sendDiscrepancyEmail(order, issues);
  }

  revalidatePath("/");
  return orders;
}

export async function submitReceipt(orderNo: string, deliveryId: string, by: string, counts: CountMap): Promise<Order> {
  const [order] = await submitRunReceipt([{ orderNo, deliveryId, counts }], by);
  return order;
}

/* ------------------------- People (packers / receivers) --------------------------- */

export async function listPeople(): Promise<Person[]> {
  const people = await prisma.person.findMany({ orderBy: { createdAt: "asc" } });
  return people.map((p) => ({ id: p.id, name: p.name, role: p.role as PersonRole }));
}

export async function addPerson(name: string, role: PersonRole): Promise<Person[]> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required.");
  await prisma.person.create({ data: { name: trimmed, role } });
  revalidatePath("/");
  return listPeople();
}

export async function removePerson(id: string): Promise<Person[]> {
  await prisma.person.delete({ where: { id } });
  revalidatePath("/");
  return listPeople();
}

/* ------------------------- Notification recipients --------------------------- */

export async function listRecipients(): Promise<NotifyRecipient[]> {
  const recipients = await prisma.notifyRecipient.findMany({ orderBy: { createdAt: "asc" } });
  return recipients.map((r) => ({
    id: r.id,
    email: r.email,
    notifyOrderCreated: r.notifyOrderCreated,
    notifyDispatch: r.notifyDispatch,
    notifyDiscrepancy: r.notifyDiscrepancy,
  }));
}

export async function addRecipient(
  email: string,
  notifyOrderCreated: boolean,
  notifyDispatch: boolean,
  notifyDiscrepancy: boolean
): Promise<NotifyRecipient[]> {
  const trimmed = email.trim();
  if (!trimmed) throw new Error("Email is required.");
  await prisma.notifyRecipient.create({ data: { email: trimmed, notifyOrderCreated, notifyDispatch, notifyDiscrepancy } });
  revalidatePath("/");
  return listRecipients();
}

export async function removeRecipient(id: string): Promise<NotifyRecipient[]> {
  await prisma.notifyRecipient.delete({ where: { id } });
  revalidatePath("/");
  return listRecipients();
}
