/* Shared domain types — used by both server (actions, email) and client (UI). */

export type Line = {
  id: string;
  partNo: string;
  desc: string;
  colour: string;
  qtyOrdered: number;
  /** Jason's own count of what the order should be — may differ from the PO qty. */
  jasonQty: number | null;
};

export type CountMap = Record<string, number>;

export type DeliveryLeg = {
  by: string;
  counts: CountMap;
};

export type Delivery = {
  id: string;
  runNo: number;
  carrier: string;
  docket: string;
  status: string;
  dispatch: DeliveryLeg | null;
  receipt: DeliveryLeg | null;
};

export type Order = {
  orderNo: string;
  status: string;
  orderDate: string;
  totalExGst: number;
  source: string;
  lines: Line[];
  deliveries: Delivery[];
};

export type OrdersMap = Record<string, Order>;

export type ReconLine = Line & {
  dispatched: number;
  received: number;
  backOrder: number;
  transitDelta: number | null;
};

export type DeliveryDelta = {
  runNo: number;
  carrier: string;
  docket: string;
  sent: number;
  got: number | null;
  delta: number | null;
};

export type TransitAlert = DeliveryDelta & { line: ReconLine };

export type Alerts = {
  packing: ReconLine[];
  backOrders: ReconLine[];
  notStarted: ReconLine[];
  transit: TransitAlert[];
  clean: boolean;
};

export type DraftLine = { partNo: string; desc: string; colour: string; qty: string };

export type ParsedOrder = { lines: { partNo: string; desc: string; colour: string; qtyOrdered: number }[]; warnings: string[] };
