import type { Alerts, CountMap, DeliveryDelta, Order, ReconLine, TransitAlert } from "@/lib/types";

export function sumCounts(map?: CountMap) {
  return Object.values(map || {}).reduce((a, b) => a + b, 0);
}

export function lineReconciliation(order: Order): ReconLine[] {
  return order.lines.map((line) => {
    let dispatched = 0;
    let received = 0;
    let hasReceipt = false;
    order.deliveries.forEach((d) => {
      dispatched += d.dispatch?.counts?.[line.id] || 0;
      if (d.receipt) {
        hasReceipt = true;
        received += d.receipt.counts?.[line.id] || 0;
      }
    });
    const backOrder = line.qtyOrdered - dispatched;
    const transitDelta = hasReceipt ? dispatched - received : null;
    return { ...line, dispatched, received, backOrder, transitDelta };
  });
}

export function deliveryDeltas(order: Order, lineId: string): DeliveryDelta[] {
  return order.deliveries
    .filter((d) => d.dispatch?.counts?.[lineId] !== undefined)
    .map((d) => {
      const sent = d.dispatch!.counts[lineId] || 0;
      const got = d.receipt ? d.receipt.counts[lineId] || 0 : null;
      return { runNo: d.runNo, carrier: d.carrier, docket: d.docket, sent, got, delta: got === null ? null : sent - got };
    });
}

export function classifyAlerts(order: Order): Alerts {
  const recon = lineReconciliation(order);
  const packing = recon.filter((l) => l.backOrder < 0 && !l.overSupplyAccepted);
  const backOrders = recon.filter((l) => l.backOrder > 0 && l.dispatched > 0);
  const notStarted = recon.filter((l) => l.dispatched === 0);
  const transit: TransitAlert[] = [];
  recon.forEach((l) => {
    deliveryDeltas(order, l.id).forEach((d) => {
      if (d.delta !== null && d.delta !== 0) transit.push({ line: l, ...d });
    });
  });
  return { packing, backOrders, notStarted, transit, clean: packing.length + transit.length === 0 };
}
