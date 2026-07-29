"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { sendDiscrepancyEmail, sendDispatchCreatedEmail } from "@/lib/email";
import { deliveryDeltas, lineReconciliation } from "@/lib/recon";
import type { CountMap, DraftLine, Order, OrdersMap } from "@/lib/types";
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
    })),
    deliveries: dbOrder.deliveries.map((d) => ({
      id: d.id,
      runNo: d.runNo,
      carrier: d.carrier,
      docket: d.docket,
      status: d.status,
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
    revalidatePath("/");
    return toOrder(dbOrder);
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

export async function startDelivery(orderNo: string, carrier: string, docket: string): Promise<Order> {
  const order = await prisma.order.findUniqueOrThrow({ where: { orderNo }, include: { deliveries: true } });
  const nextRun = order.deliveries.length + 1;
  await prisma.delivery.create({
    data: { orderId: order.id, runNo: nextRun, carrier: carrier || "—", docket: docket || "—", status: "draft" },
  });
  revalidatePath("/");
  return loadOrder(orderNo);
}

export async function submitDispatch(orderNo: string, deliveryId: string, by: string, counts: CountMap): Promise<Order> {
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: { status: "dispatched", dispatchBy: by, dispatchCounts: counts },
  });

  const order = await loadOrder(orderNo);
  const delivery = order.deliveries.find((d) => d.id === deliveryId);
  if (!delivery) throw new Error("Delivery not found after update.");

  await sendDispatchCreatedEmail(order, delivery);

  const touchedIds = new Set(Object.keys(counts));
  const recon = lineReconciliation(order);
  const overPacked = recon
    .filter((l) => touchedIds.has(l.id) && l.backOrder < 0)
    .map((l) => `${l.partNo} — run ${String(delivery.runNo).padStart(2, "0")}: ${Math.abs(l.backOrder)} more dispatched than ordered.`);
  await sendDiscrepancyEmail(order, overPacked);

  revalidatePath("/");
  return order;
}

export async function submitReceipt(orderNo: string, deliveryId: string, by: string, counts: CountMap): Promise<Order> {
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: { status: "received", receiptBy: by, receiptCounts: counts },
  });

  const order = await loadOrder(orderNo);
  const delivery = order.deliveries.find((d) => d.id === deliveryId);
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

  revalidatePath("/");
  return order;
}

export async function updateJasonQty(orderNo: string, lineId: string, qty: number | null): Promise<Order> {
  await prisma.line.update({ where: { id: lineId }, data: { jasonQty: qty } });
  revalidatePath("/");
  return loadOrder(orderNo);
}
