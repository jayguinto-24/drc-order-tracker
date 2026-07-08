"use client";

import React, { useState } from "react";

/* =================================================================
   BSSP ORDER TRACKER — prototype
   Three-way blind reconciliation: Ordered (Brett) vs Dispatched
   (Border packing, blind) vs Received (DRC goods-in, blind).
   David (DRC) and Jason (Border) both see the full master ledger.
   ================================================================= */

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600;700&display=swap');
`;

const T = {
  page: "#E4E9EB",
  panel: "#FFFFFF",
  ink: "#101820",
  steel: "#5A6B76",
  faint: "#8B9AA3",
  line: "#D3DBDF",
  lineSoft: "#E3E8EA",
  navy: "#1D3A4A",
  navySoft: "#EAF0F3",
  orange: "#E85A1C",
  orangeSoft: "#FDECE2",
  ok: "#1F7A55",
  okSoft: "#E5F3EC",
  flag: "#C23B2E",
  flagSoft: "#FBEAE7",
  pending: "#A9760B",
  pendingSoft: "#FBF1DC",
};

const font = {
  display: "'Archivo', sans-serif",
  body: "'Inter', sans-serif",
  mono: "'JetBrains Mono', monospace",
};

/* ------------------------- Types --------------------------- */

type Line = {
  id: string;
  partNo: string;
  desc: string;
  colour: string;
  qtyOrdered: number;
};

type CountMap = Record<string, number>;

type DeliveryLeg = {
  by: string;
  counts: CountMap;
};

type Delivery = {
  id: string;
  runNo: number;
  carrier: string;
  docket: string;
  status: string;
  dispatch: DeliveryLeg | null;
  receipt: DeliveryLeg | null;
};

type Order = {
  orderNo: string;
  status: string;
  orderDate: string;
  totalExGst: number;
  source: string;
  lines: Line[];
  deliveries: Delivery[];
};

type OrdersMap = Record<string, Order>;

type ReconLine = Line & {
  dispatched: number;
  received: number;
  backOrder: number;
  transitDelta: number | null;
};

type DeliveryDelta = {
  runNo: number;
  carrier: string;
  docket: string;
  sent: number;
  got: number | null;
  delta: number | null;
};

type TransitAlert = DeliveryDelta & { line: ReconLine };

type Alerts = {
  packing: ReconLine[];
  backOrders: ReconLine[];
  notStarted: ReconLine[];
  transit: TransitAlert[];
  clean: boolean;
};

type DraftLine = { partNo: string; desc: string; colour: string; qty: string };

type ParsedOrder = { lines: Line[]; warnings: string[] };

/* ------------------------- Seed data --------------------------- */

const seedOrders: OrdersMap = {
  "BSSP-087": {
    orderNo: "BSSP-087",
    status: "open",
    orderDate: "2026-01-12",
    totalExGst: 12234.63,
    source: "manual",
    lines: [
      { id: "L1", partNo: "SW-2400", desc: "Side wall panel 2.4m", colour: "Colorbond Monument", qtyOrdered: 40 },
      { id: "L2", partNo: "EW-3000", desc: "End wall panel 3.0m", colour: "Colorbond Monument", qtyOrdered: 10 },
      { id: "L3", partNo: "RF-6000", desc: "Roof sheet 6.0m", colour: "Zincalume", qtyOrdered: 24 },
      { id: "L4", partNo: "FL-BRK", desc: "Flashing bracket kit", colour: "—", qtyOrdered: 60 },
      { id: "L5", partNo: "DR-HNG", desc: "Door hinge set", colour: "Powder white", qtyOrdered: 8 },
    ],
    deliveries: [
      {
        id: "D1", runNo: 1, carrier: "BSSP Truck", docket: "BT-4471", status: "received",
        dispatch: { by: "Craig G", counts: { L1: 40, L2: 6, L3: 24, L4: 30, L5: 8 } },
        receipt: { by: "Owen N", counts: { L1: 40, L2: 6, L3: 21, L4: 30, L5: 8 } },
      },
      {
        id: "D2", runNo: 2, carrier: "MF", docket: "—", status: "received",
        dispatch: { by: "Craig G", counts: { L2: 5, L4: 30 } },
        receipt: { by: "Bree C", counts: { L2: 5, L4: 30 } },
      },
      {
        id: "D3", runNo: 3, carrier: "BSSP Truck", docket: "BT-4502", status: "dispatched",
        dispatch: { by: "Craig G", counts: { L3: 0 } },
        receipt: null,
      },
    ],
  },
  "BSSP-091": {
    orderNo: "BSSP-091",
    status: "open",
    orderDate: "2026-02-03",
    totalExGst: 4310.0,
    source: "manual",
    lines: [
      { id: "L1", partNo: "SW-2400", desc: "Side wall panel 2.4m", colour: "Colorbond Woodland Grey", qtyOrdered: 16 },
      { id: "L2", partNo: "RF-4500", desc: "Roof sheet 4.5m", colour: "Zincalume", qtyOrdered: 12 },
    ],
    deliveries: [],
  },
};

const PACKERS = ["Craig G", "Terry M", "Josh P"];
const RECEIVERS = ["Owen N", "Bree C", "Grace T"];

/* ------------------------- Helpers --------------------------- */

function sumCounts(map?: CountMap) {
  return Object.values(map || {}).reduce((a, b) => a + b, 0);
}

function lineReconciliation(order: Order): ReconLine[] {
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

function deliveryDeltas(order: Order, lineId: string): DeliveryDelta[] {
  return order.deliveries
    .filter((d) => d.dispatch?.counts?.[lineId] !== undefined)
    .map((d) => {
      const sent = d.dispatch!.counts[lineId] || 0;
      const got = d.receipt ? d.receipt.counts[lineId] || 0 : null;
      return { runNo: d.runNo, carrier: d.carrier, docket: d.docket, sent, got, delta: got === null ? null : sent - got };
    });
}

function classifyAlerts(order: Order): Alerts {
  const recon = lineReconciliation(order);
  const packing = recon.filter((l) => l.backOrder < 0);
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

/* ------------------------- Shell --------------------------- */

const ROLE_TABS = [
  { id: "david", label: "David", tag: "Master · DRC" },
  { id: "jason", label: "Jason", tag: "Master · Border" },
  { id: "brett", label: "Brett", tag: "Ordering · DRC" },
  { id: "packer", label: "Packing crew", tag: "Border · blind" },
  { id: "receiver", label: "Goods in", tag: "DRC · blind" },
];

/* Demo-only access codes for the two master roles. This is a client-side
   gate for walkthroughs — the code ships in the bundle, so it is NOT real
   security. Production access control has to happen server-side (see
   Phase 1 of the implementation spec: role-scoped API responses). */
const MASTER_PINS: Record<string, string> = { david: "1287", jason: "2471" };

export default function App() {
  const [orders, setOrders] = useState<OrdersMap>(seedOrders);
  const [activeOrderNo, setActiveOrderNo] = useState("BSSP-087");
  const [role, setRole] = useState("brett");
  const [unlocked, setUnlocked] = useState<Record<string, boolean>>({ david: false, jason: false });
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const order = orders[activeOrderNo];

  function updateOrder(orderNo: string, updater: (o: Order) => Order) {
    setOrders((prev) => ({ ...prev, [orderNo]: updater(prev[orderNo]) }));
  }

  function requestRole(id: string) {
    if ((id === "david" || id === "jason") && !unlocked[id]) {
      setPendingRole(id);
    } else {
      setRole(id);
    }
  }

  function lockRole(id: string) {
    setUnlocked((u) => ({ ...u, [id]: false }));
    setRole("brett");
  }

  function unlockWith(id: string) {
    setUnlocked((u) => ({ ...u, [id]: true }));
    setRole(id);
    setPendingRole(null);
  }

  return (
    <div style={{ minHeight: "100vh", background: T.page, fontFamily: font.body, color: T.ink, position: "relative" }}>
      <style>{FONTS}</style>

      <TopBar
        orders={orders}
        activeOrderNo={activeOrderNo}
        setActiveOrderNo={setActiveOrderNo}
        role={role}
        requestRole={requestRole}
        unlocked={unlocked}
        onLock={lockRole}
      />

      <main style={{ maxWidth: 1040, margin: "0 auto", padding: "28px 24px 80px" }}>
        {(role === "david" || role === "jason") && <MasterView order={order} viewer={role} />}
        {role === "brett" && <OrderingView orders={orders} setOrders={setOrders} activeOrderNo={activeOrderNo} setActiveOrderNo={setActiveOrderNo} />}
        {role === "packer" && <PackingView order={order} updateOrder={(u) => updateOrder(activeOrderNo, u)} />}
        {role === "receiver" && <ReceivingView order={order} updateOrder={(u) => updateOrder(activeOrderNo, u)} />}
      </main>

      {pendingRole && (
        <AccessGateModal
          roleId={pendingRole}
          onCancel={() => setPendingRole(null)}
          onUnlock={() => unlockWith(pendingRole)}
        />
      )}
    </div>
  );
}

function AccessGateModal({ roleId, onCancel, onUnlock }: { roleId: string; onCancel: () => void; onUnlock: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const name = roleId === "david" ? "David" : "Jason";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pin === MASTER_PINS[roleId]) {
      onUnlock();
    } else {
      setError(true);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(16,24,32,0.55)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 50,
    }}>
      <form onSubmit={submit} style={{ background: T.panel, borderRadius: 12, padding: 24, width: 320, boxShadow: "0 12px 32px rgba(0,0,0,0.25)" }}>
        <div style={{ fontFamily: font.display, fontWeight: 800, fontSize: 15 }}>{name}&apos;s master access</div>
        <div style={{ fontSize: 12, color: T.faint, marginTop: 4, marginBottom: 14, lineHeight: 1.6 }}>
          This view shows ordered, dispatched and received quantities in full. Enter {name}&apos;s access code to continue.
        </div>
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => { setPin(e.target.value); setError(false); }}
          placeholder="Access code"
          style={{ ...inputStyle, letterSpacing: 3, fontFamily: font.mono, marginTop: 0 }}
        />
        {error && <div style={{ fontSize: 11.5, color: T.flag, marginTop: 6 }}>That code doesn&apos;t match. Try again.</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onCancel} style={{ ...secondaryBtn, flex: 1 }}>Cancel</button>
          <button type="submit" style={{ ...primaryBtn, flex: 1 }}>Unlock</button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------- Top bar --------------------------- */

function TopBar({ orders, activeOrderNo, setActiveOrderNo, role, requestRole, unlocked, onLock }: {
  orders: OrdersMap;
  activeOrderNo: string;
  setActiveOrderNo: (no: string) => void;
  role: string;
  requestRole: (id: string) => void;
  unlocked: Record<string, boolean>;
  onLock: (id: string) => void;
}) {
  return (
    <div style={{ background: T.navy, borderBottom: `4px solid ${T.orange}` }}>
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "18px 24px 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontFamily: font.display, fontWeight: 800, fontSize: 22, color: "#fff", letterSpacing: 0.3 }}>
              BSSP ORDER TRACKER
            </div>
            <div style={{ fontSize: 12, color: "#9FB4BF", marginTop: 2, letterSpacing: 0.3 }}>
              Three-way count reconciliation — DRC ⇄ Border
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {(role === "david" || role === "jason") && (
              <button onClick={() => onLock(role)} style={{
                background: "transparent", border: `1px solid #2C4C5C`, color: "#C7D6DC",
                borderRadius: 6, padding: "7px 12px", fontSize: 11.5, cursor: "pointer",
              }}>
                Lock {role === "david" ? "David's" : "Jason's"} view
              </button>
            )}
            <select
              value={activeOrderNo}
              onChange={(e) => setActiveOrderNo(e.target.value)}
              style={{
                background: "#16303D", color: "#fff", border: `1px solid #2C4C5C`, borderRadius: 6,
                padding: "8px 12px", fontFamily: font.mono, fontSize: 13, fontWeight: 600,
              }}
            >
              {Object.keys(orders).map((no) => (
                <option key={no} value={no}>{no}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, marginTop: 18, overflowX: "auto" }}>
          {ROLE_TABS.map((r) => {
            const active = role === r.id;
            const isMaster = r.id === "david" || r.id === "jason";
            const isLocked = isMaster && !unlocked[r.id];
            return (
              <button
                key={r.id}
                onClick={() => requestRole(r.id)}
                style={{
                  background: active ? T.panel : "transparent",
                  color: active ? T.ink : "#C7D6DC",
                  border: "none",
                  borderRadius: "8px 8px 0 0",
                  padding: "10px 16px 12px",
                  cursor: "pointer",
                  textAlign: "left",
                  minWidth: 128,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: font.display, fontWeight: 700, fontSize: 13.5 }}>
                  {r.label}
                  {isLocked && <LockGlyph color={active ? T.steel : "#8FA5AF"} />}
                </div>
                <div style={{ fontSize: 10.5, marginTop: 2, color: active ? T.steel : "#8FA5AF", letterSpacing: 0.3, textTransform: "uppercase" }}>
                  {r.tag}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LockGlyph({ color }: { color: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/* ------------------------- Master view --------------------------- */

function MasterView({ order, viewer }: { order: Order; viewer: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const recon = lineReconciliation(order);
  const alerts = classifyAlerts(order);
  const isJason = viewer === "jason";

  return (
    <div>
      <SummaryStrip order={order} recon={recon} />
      <DeliveryRail order={order} />
      <AlertsPanel order={order} alerts={alerts} isJason={isJason} />

      <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.line}`, fontFamily: font.display, fontWeight: 700, fontSize: 14 }}>
          Master ledger
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: T.navySoft, textAlign: "left" }}>
              {["Part", "Colour", "Ordered", "Dispatched", "Received", "Back order", "Status"].map((h) => (
                <th key={h} style={{ padding: "9px 14px", fontSize: 10.5, letterSpacing: 0.5, textTransform: "uppercase", color: T.steel, fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recon.map((l) => {
              const status = statusFor(l);
              const isOpen = expanded === l.id;
              return (
                <React.Fragment key={l.id}>
                  <tr
                    onClick={() => setExpanded(isOpen ? null : l.id)}
                    style={{ borderTop: `1px solid ${T.lineSoft}`, cursor: "pointer" }}
                  >
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ fontFamily: font.mono, fontWeight: 600, fontSize: 12.5 }}>{l.partNo}</div>
                      <div style={{ fontSize: 11.5, color: T.faint }}>{l.desc}</div>
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: T.steel }}>{l.colour}</td>
                    <td style={{ padding: "10px 14px", fontFamily: font.mono }}>{l.qtyOrdered}</td>
                    <td style={{ padding: "10px 14px", fontFamily: font.mono }}>{l.dispatched}</td>
                    <td style={{ padding: "10px 14px", fontFamily: font.mono }}>{l.received}</td>
                    <td style={{ padding: "10px 14px", fontFamily: font.mono, color: l.backOrder < 0 ? T.flag : l.backOrder > 0 ? T.pending : T.ok }}>
                      {l.backOrder > 0 ? `+${l.backOrder} owed` : l.backOrder < 0 ? `${Math.abs(l.backOrder)} over` : "0"}
                    </td>
                    <td style={{ padding: "10px 14px" }}><Pill {...status} /></td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={7} style={{ padding: "0 14px 14px", background: "#FAFBFC" }}>
                        <PerDeliveryBreakdown order={order} lineId={l.id} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11.5, color: T.faint, marginTop: 14, lineHeight: 1.6 }}>
        {viewer === "david" ? "David" : "Jason"} sees the complete picture — ordered, dispatched and received —
        exactly as agreed. Packers and goods-in never see the numbers they&apos;re checked against. Click any row for its per-delivery breakdown.
      </p>
    </div>
  );
}

function statusFor(l: ReconLine): { label: string; bg: string; fg: string } {
  if (l.transitDelta && l.transitDelta !== 0) return { label: "Transit loss", bg: T.flagSoft, fg: T.flag };
  if (l.backOrder < 0) return { label: "Over-dispatched", bg: T.flagSoft, fg: T.flag };
  if (l.dispatched === 0) return { label: "Not started", bg: T.lineSoft, fg: T.steel };
  if (l.backOrder > 0) return { label: "Back order", bg: T.pendingSoft, fg: T.pending };
  return { label: "Reconciled", bg: T.okSoft, fg: T.ok };
}

function Pill({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span style={{ background: bg, color: fg, fontSize: 10.5, fontWeight: 600, padding: "4px 9px", borderRadius: 20, letterSpacing: 0.2 }}>
      {label}
    </span>
  );
}

function SummaryStrip({ order, recon }: { order: Order; recon: ReconLine[] }) {
  const totalOrdered = recon.reduce((a, l) => a + l.qtyOrdered, 0);
  const totalDispatched = recon.reduce((a, l) => a + l.dispatched, 0);
  const totalReceived = recon.reduce((a, l) => a + l.received, 0);
  const stats = [
    { label: "Order total (ex GST)", value: `$${order.totalExGst.toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
    { label: "Units ordered", value: totalOrdered },
    { label: "Units dispatched", value: totalDispatched },
    { label: "Units received", value: totalReceived },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
      {stats.map((s) => (
        <div key={s.label} style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 10.5, color: T.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>{s.label}</div>
          <div style={{ fontFamily: font.mono, fontWeight: 600, fontSize: 18, marginTop: 4 }}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

function DeliveryRail({ order }: { order: Order }) {
  if (order.deliveries.length === 0) {
    return (
      <div style={{ border: `1px dashed ${T.line}`, borderRadius: 10, padding: 16, marginBottom: 16, fontSize: 12.5, color: T.faint, textAlign: "center" }}>
        No deliveries dispatched yet for {order.orderNo}.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 10, overflowX: "auto", marginBottom: 16, paddingBottom: 4 }}>
      {order.deliveries.map((d) => (
        <div
          key={d.id}
          style={{
            minWidth: 168, background: T.panel, border: `1px dashed ${T.line}`, borderRadius: 6,
            padding: "10px 12px", flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontFamily: font.display, fontWeight: 700, fontSize: 12.5 }}>Run {String(d.runNo).padStart(2, "0")}</span>
            <Pill {...(d.status === "received" ? { label: "Received", bg: T.okSoft, fg: T.ok } : { label: "In transit", bg: T.pendingSoft, fg: T.pending })} />
          </div>
          <div style={{ fontSize: 11.5, color: T.steel, marginTop: 6 }}>{d.carrier}</div>
          <div style={{ fontFamily: font.mono, fontSize: 11, color: T.faint, marginTop: 2 }}>Docket {d.docket}</div>
        </div>
      ))}
    </div>
  );
}

function PerDeliveryBreakdown({ order, lineId }: { order: Order; lineId: string }) {
  const rows = deliveryDeltas(order, lineId);
  if (rows.length === 0) return <div style={{ fontSize: 12, color: T.faint, padding: "10px 0" }}>No dispatches recorded yet.</div>;
  return (
    <table style={{ width: "100%", fontSize: 12, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: "left", color: T.faint, fontSize: 10.5, textTransform: "uppercase" }}>
          <th style={{ padding: "4px 8px" }}>Run</th>
          <th style={{ padding: "4px 8px" }}>Carrier</th>
          <th style={{ padding: "4px 8px" }}>Sent</th>
          <th style={{ padding: "4px 8px" }}>Received</th>
          <th style={{ padding: "4px 8px" }}>Delta</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.runNo} style={{ borderTop: `1px solid ${T.lineSoft}` }}>
            <td style={{ padding: "6px 8px", fontFamily: font.mono }}>{String(r.runNo).padStart(2, "0")}</td>
            <td style={{ padding: "6px 8px" }}>{r.carrier}</td>
            <td style={{ padding: "6px 8px", fontFamily: font.mono }}>{r.sent}</td>
            <td style={{ padding: "6px 8px", fontFamily: font.mono }}>{r.got === null ? "—" : r.got}</td>
            <td style={{ padding: "6px 8px", fontFamily: font.mono, color: r.delta ? T.flag : T.ok }}>
              {r.delta === null ? "pending" : r.delta === 0 ? "0" : r.delta}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AlertsPanel({ alerts, isJason }: { order?: Order; alerts: Alerts; isJason: boolean }) {
  if (alerts.clean) {
    return (
      <div style={{ background: T.okSoft, border: `1px solid ${T.ok}33`, borderRadius: 10, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
        <StampMark ok />
        <span style={{ fontSize: 13, color: T.ok, fontWeight: 600 }}>Everything reconciles — no mismatches flagged.</span>
      </div>
    );
  }
  return (
    <div style={{ background: T.flagSoft, border: `1px solid ${T.flag}33`, borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <StampMark ok={false} />
        <span style={{ fontSize: 13, color: T.flag, fontWeight: 700, fontFamily: font.display }}>Mismatches need attention</span>
      </div>
      {alerts.packing.length > 0 && (
        <AlertGroup title={isJason ? "At your end — over-packed" : "At packing"} color={T.flag}>
          {alerts.packing.map((l) => (
            <div key={l.id}>{l.partNo} — {Math.abs(l.backOrder)} more dispatched than ordered</div>
          ))}
        </AlertGroup>
      )}
      {alerts.transit.length > 0 && (
        <AlertGroup title="In transit" color={T.flag}>
          {alerts.transit.map((r, i) => (
            <div key={i}>{r.line.partNo} — run {String(r.runNo).padStart(2, "0")} ({r.carrier}): sent {r.sent}, received {r.got}, {(r.delta ?? 0) > 0 ? `${r.delta} missing` : `${Math.abs(r.delta ?? 0)} extra`}</div>
          ))}
        </AlertGroup>
      )}
      {alerts.backOrders.length > 0 && (
        <AlertGroup title="Back order — still owed" color={T.pending}>
          {alerts.backOrders.map((l) => (
            <div key={l.id}>{l.partNo} — {l.backOrder} still to be dispatched</div>
          ))}
        </AlertGroup>
      )}
    </div>
  );
}

function AlertGroup({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: T.ink, lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

function StampMark({ ok }: { ok: boolean }) {
  return (
    <div style={{
      width: 26, height: 26, borderRadius: "50%", border: `2px solid ${ok ? T.ok : T.flag}`,
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      color: ok ? T.ok : T.flag, fontWeight: 800, fontSize: 13, fontFamily: font.display,
    }}>
      {ok ? "✓" : "!"}
    </div>
  );
}

/* ------------------------- Ordering view (Brett) --------------------------- */

/* ---- flexible parser for pasted / uploaded order data (CSV or TSV) ----
   Accepts a header row containing some form of: part, description,
   colour, qty. Column order and exact naming are flexible; anything
   unrecognised is skipped with a warning rather than silently guessed. */
function parseDelimitedOrder(text: string): ParsedOrder {
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter((r) => r.length > 0);
  if (rows.length < 2) return { lines: [], warnings: ["No data rows found below the header."] };
  const delim = rows[0].includes("\t") ? "\t" : ",";
  const header = rows[0].split(delim).map((h) => h.trim().toLowerCase());

  const find = (...keys: string[]) => header.findIndex((h) => keys.some((k) => h.includes(k)));
  const idx = {
    partNo: find("part", "sku", "code"),
    desc: find("desc", "item", "name"),
    colour: find("colour", "color"),
    qty: find("qty", "quantity", "ordered"),
  };

  const warnings: string[] = [];
  if (idx.partNo === -1) warnings.push("No 'part number' column found — using column 1.");
  if (idx.qty === -1) warnings.push("No 'quantity' column found — lines without a recognisable qty will be skipped.");

  const lines: Line[] = [];
  rows.slice(1).forEach((row, i) => {
    const cells = row.split(delim).map((c) => c.trim());
    const partNo = cells[idx.partNo !== -1 ? idx.partNo : 0] || "";
    const qtyRaw = cells[idx.qty !== -1 ? idx.qty : -1];
    const qty = Number(qtyRaw);
    if (!partNo || !qtyRaw || Number.isNaN(qty) || qty <= 0) {
      warnings.push(`Row ${i + 2}: skipped — missing part number or a valid quantity.`);
      return;
    }
    lines.push({
      id: `L${lines.length + 1}`,
      partNo,
      desc: idx.desc !== -1 ? cells[idx.desc] || "" : "",
      colour: idx.colour !== -1 ? cells[idx.colour] || "—" : "—",
      qtyOrdered: qty,
    });
  });

  return { lines, warnings };
}

function OrderingView({ orders, setOrders, activeOrderNo, setActiveOrderNo }: {
  orders: OrdersMap;
  setOrders: React.Dispatch<React.SetStateAction<OrdersMap>>;
  activeOrderNo: string;
  setActiveOrderNo: (no: string) => void;
}) {
  const [mode, setMode] = useState("manual"); // 'manual' | 'import'
  const [newOrderNo, setNewOrderNo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ partNo: "", desc: "", colour: "", qty: "" }]);

  const [importOrderNo, setImportOrderNo] = useState("");
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ParsedOrder | null>(null);

  function addLine() {
    setLines([...lines, { partNo: "", desc: "", colour: "", qty: "" }]);
  }
  function updateLine(i: number, field: keyof DraftLine, val: string) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, [field]: val } : l)));
  }
  function createOrder() {
    if (!newOrderNo.trim()) return;
    const validLines = lines.filter((l) => l.partNo && l.qty);
    if (validLines.length === 0) return;
    commitOrder(newOrderNo, validLines.map((l, i) => ({ id: `L${i + 1}`, partNo: l.partNo, desc: l.desc, colour: l.colour || "—", qtyOrdered: Number(l.qty) })));
    setNewOrderNo("");
    setLines([{ partNo: "", desc: "", colour: "", qty: "" }]);
  }

  function commitOrder(orderNo: string, lineList: Line[]) {
    setOrders((prev) => ({
      ...prev,
      [orderNo]: {
        orderNo,
        status: "open",
        orderDate: new Date().toISOString().slice(0, 10),
        totalExGst: 0,
        lines: lineList,
        deliveries: [],
        source: prev[orderNo]?.source === "excel_import" ? "excel_import" : "manual",
      },
    }));
    setActiveOrderNo(orderNo);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    if (!importOrderNo) setImportOrderNo(file.name.replace(/\.(csv|txt|tsv)$/i, ""));
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = String(evt.target?.result);
      setRawText(text);
      setPreview(parseDelimitedOrder(text));
    };
    reader.readAsText(file);
  }

  function handlePasteChange(val: string) {
    setRawText(val);
    setPreview(val.trim() ? parseDelimitedOrder(val) : null);
  }

  function commitImport() {
    if (!importOrderNo.trim() || !preview || preview.lines.length === 0) return;
    setOrders((prev) => ({
      ...prev,
      [importOrderNo]: {
        orderNo: importOrderNo,
        status: "open",
        orderDate: new Date().toISOString().slice(0, 10),
        totalExGst: 0,
        lines: preview.lines,
        deliveries: [],
        source: "excel_import",
      },
    }));
    setActiveOrderNo(importOrderNo);
    setImportOrderNo("");
    setRawText("");
    setFileName("");
    setPreview(null);
  }

  return (
    <div>
      <SectionHeader title="Orders" note="Create an order by hand, or import one from a spreadsheet export — any order number, any file." />

      <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, overflow: "hidden", marginBottom: 20 }}>
        {Object.values(orders).map((o) => (
          <div key={o.orderNo} onClick={() => setActiveOrderNo(o.orderNo)}
            style={{
              padding: "12px 16px", borderTop: `1px solid ${T.lineSoft}`, cursor: "pointer",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              background: o.orderNo === activeOrderNo ? T.navySoft : "transparent",
            }}>
            <div>
              <div style={{ fontFamily: font.mono, fontWeight: 700, fontSize: 13 }}>{o.orderNo}</div>
              <div style={{ fontSize: 11.5, color: T.faint }}>{o.lines.length} lines · placed {o.orderDate}{o.source === "excel_import" ? " · imported" : ""}</div>
            </div>
            <Pill label={o.status} bg={T.lineSoft} fg={T.steel} />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: -1 }}>
        {[{ id: "manual", label: "Manual entry" }, { id: "import", label: "Import file" }].map((t) => (
          <button key={t.id} onClick={() => setMode(t.id)}
            style={{
              background: mode === t.id ? T.panel : "transparent", border: `1px solid ${T.line}`,
              borderBottom: mode === t.id ? "1px solid transparent" : `1px solid ${T.line}`,
              borderRadius: "8px 8px 0 0", padding: "9px 16px", fontSize: 12.5, fontWeight: 600,
              cursor: "pointer", color: mode === t.id ? T.ink : T.faint,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {mode === "manual" && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: "0 10px 10px 10px", padding: 18 }}>
          <input placeholder="Order number, e.g. BSSP-095" value={newOrderNo} onChange={(e) => setNewOrderNo(e.target.value)}
            style={inputStyle} />
          {lines.map((l, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr 0.6fr", gap: 8, marginTop: 8 }}>
              <input placeholder="Part no" value={l.partNo} onChange={(e) => updateLine(i, "partNo", e.target.value)} style={inputStyle} />
              <input placeholder="Description" value={l.desc} onChange={(e) => updateLine(i, "desc", e.target.value)} style={inputStyle} />
              <input placeholder="Colour" value={l.colour} onChange={(e) => updateLine(i, "colour", e.target.value)} style={inputStyle} />
              <input placeholder="Qty" type="number" value={l.qty} onChange={(e) => updateLine(i, "qty", e.target.value)} style={inputStyle} />
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={addLine} style={secondaryBtn}>+ Add line</button>
            <button onClick={createOrder} style={primaryBtn}>Create order</button>
          </div>
        </div>
      )}

      {mode === "import" && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: "0 10px 10px 10px", padding: 18 }}>
          <label style={labelStyle}>Order number</label>
          <input placeholder="e.g. BSSP-102" value={importOrderNo} onChange={(e) => setImportOrderNo(e.target.value)} style={inputStyle} />

          <label style={labelStyle}>Upload a .csv export</label>
          <input type="file" accept=".csv,.txt,.tsv" onChange={handleFile}
            style={{ ...inputStyle, padding: "7px 10px" }} />
          {fileName && <div style={{ fontSize: 11.5, color: T.faint, marginTop: 4 }}>Loaded {fileName}</div>}

          <label style={labelStyle}>...or paste rows directly (comma or tab separated, header row required)</label>
          <textarea
            value={rawText}
            onChange={(e) => handlePasteChange(e.target.value)}
            placeholder={"Part No,Description,Colour,Qty\nSW-2400,Side wall panel 2.4m,Monument,40\nEW-3000,End wall panel 3.0m,Monument,10"}
            rows={5}
            style={{ ...inputStyle, fontFamily: font.mono, fontSize: 12, resize: "vertical" }}
          />

          {preview && (
            <div style={{ marginTop: 14, border: `1px solid ${T.line}`, borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "8px 12px", background: T.navySoft, fontSize: 11.5, fontWeight: 600 }}>
                Preview — {preview.lines.length} line{preview.lines.length === 1 ? "" : "s"} recognised
              </div>
              {preview.lines.length > 0 && (
                <table style={{ width: "100%", fontSize: 12 }}>
                  <tbody>
                    {preview.lines.map((l) => (
                      <tr key={l.id} style={{ borderTop: `1px solid ${T.lineSoft}` }}>
                        <td style={{ padding: "6px 12px", fontFamily: font.mono }}>{l.partNo}</td>
                        <td style={{ padding: "6px 12px", color: T.steel }}>{l.desc}</td>
                        <td style={{ padding: "6px 12px", color: T.steel }}>{l.colour}</td>
                        <td style={{ padding: "6px 12px", fontFamily: font.mono, textAlign: "right" }}>{l.qtyOrdered}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {preview.warnings.length > 0 && (
                <div style={{ padding: "8px 12px", background: T.pendingSoft, fontSize: 11.5, color: T.pending }}>
                  {preview.warnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              onClick={commitImport}
              disabled={!preview || preview.lines.length === 0 || !importOrderNo.trim()}
              style={{ ...primaryBtn, opacity: (!preview || preview.lines.length === 0 || !importOrderNo.trim()) ? 0.45 : 1 }}
            >
              Create order from import
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------- Packing view (blind) --------------------------- */

function PackingView({ order, updateOrder }: { order: Order; updateOrder: (updater: (o: Order) => Order) => void }) {
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [carrier, setCarrier] = useState("BSSP Truck");
  const [docket, setDocket] = useState("");
  const [counts, setCounts] = useState<CountMap>({});
  const [countedBy, setCountedBy] = useState(PACKERS[0]);
  const [submitted, setSubmitted] = useState(false);

  const openDeliveries = order.deliveries.filter((d) => d.status === "draft");
  const editing = order.deliveries.find((d) => d.id === selectedDeliveryId);

  function startNewDelivery() {
    const nextRun = order.deliveries.length + 1;
    const id = `D${Date.now()}`;
    updateOrder((o) => ({ ...o, deliveries: [...o.deliveries, { id, runNo: nextRun, carrier, docket: docket || "—", status: "draft", dispatch: null, receipt: null }] }));
    setSelectedDeliveryId(id);
    setCreating(false);
    setCounts({});
    setSubmitted(false);
  }

  function submit() {
    updateOrder((o) => ({
      ...o,
      deliveries: o.deliveries.map((d) =>
        d.id === selectedDeliveryId ? { ...d, status: "dispatched", dispatch: { by: countedBy, counts } } : d
      ),
    }));
    setSubmitted(true);
  }

  return (
    <div>
      <SectionHeader title="Border packing — blind count" note="You see part numbers only. Ordered quantities and back orders are hidden — count exactly what leaves the bench." />

      {!selectedDeliveryId && !creating && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontSize: 13, marginBottom: 12 }}>Start a new delivery run for <strong>{order.orderNo}</strong>, or continue one in progress.</div>
          <button onClick={() => setCreating(true)} style={primaryBtn}>+ New dispatch</button>
          {openDeliveries.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {openDeliveries.map((d) => (
                <div key={d.id} onClick={() => setSelectedDeliveryId(d.id)} style={{ padding: "10px 0", borderTop: `1px solid ${T.lineSoft}`, cursor: "pointer", fontSize: 13 }}>
                  Run {String(d.runNo).padStart(2, "0")} — {d.carrier} (in progress)
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {creating && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>New dispatch — {order.orderNo}</div>
          <label style={labelStyle}>Carrier</label>
          <input value={carrier} onChange={(e) => setCarrier(e.target.value)} style={inputStyle} />
          <label style={labelStyle}>Docket number (optional)</label>
          <input value={docket} onChange={(e) => setDocket(e.target.value)} style={inputStyle} placeholder="—" />
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={() => setCreating(false)} style={secondaryBtn}>Cancel</button>
            <button onClick={startNewDelivery} style={primaryBtn}>Start crate count</button>
          </div>
        </div>
      )}

      {editing && !submitted && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
            Run {String(editing.runNo).padStart(2, "0")} — {editing.carrier}
          </div>
          <div style={{ fontSize: 11.5, color: T.faint, marginBottom: 14 }}>Docket {editing.docket}</div>
          {order.lines.map((l) => (
            <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${T.lineSoft}` }}>
              <div>
                <div style={{ fontFamily: font.mono, fontWeight: 600, fontSize: 13 }}>{l.partNo}</div>
                <div style={{ fontSize: 11.5, color: T.faint }}>{l.desc}</div>
              </div>
              <input type="number" min="0" placeholder="Qty packed" value={counts[l.id] ?? ""}
                onChange={(e) => setCounts({ ...counts, [l.id]: Number(e.target.value) })}
                style={{ ...inputStyle, width: 96, textAlign: "right", fontFamily: font.mono, margin: 0 }} />
            </div>
          ))}
          <label style={{ ...labelStyle, marginTop: 16 }}>Counted by</label>
          <select value={countedBy} onChange={(e) => setCountedBy(e.target.value)} style={inputStyle}>
            {PACKERS.map((p) => <option key={p}>{p}</option>)}
          </select>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={() => setSelectedDeliveryId(null)} style={secondaryBtn}>Back</button>
            <button onClick={submit} style={primaryBtn}>Submit and lock</button>
          </div>
        </div>
      )}

      {submitted && editing && (
        <ConfirmBanner text={`Run ${String(editing.runNo).padStart(2, "0")} submitted and locked. It's now visible to David and Jason on the master ledger.`}
          onDone={() => { setSelectedDeliveryId(null); setSubmitted(false); }} />
      )}
    </div>
  );
}

/* ------------------------- Receiving view (blind) --------------------------- */

function ReceivingView({ order, updateOrder }: { order: Order; updateOrder: (updater: (o: Order) => Order) => void }) {
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [counts, setCounts] = useState<CountMap>({});
  const [countedBy, setCountedBy] = useState(RECEIVERS[0]);
  const [submitted, setSubmitted] = useState(false);

  const arrivable = order.deliveries.filter((d) => d.status === "dispatched");
  const editing = order.deliveries.find((d) => d.id === selectedDeliveryId);
  const linesInDelivery = editing ? order.lines.filter((l) => editing.dispatch?.counts[l.id] !== undefined) : [];

  function submit() {
    updateOrder((o) => ({
      ...o,
      deliveries: o.deliveries.map((d) =>
        d.id === selectedDeliveryId ? { ...d, status: "received", receipt: { by: countedBy, counts } } : d
      ),
    }));
    setSubmitted(true);
  }

  return (
    <div>
      <SectionHeader title="DRC goods-in — blind count" note="You see which delivery arrived, not what was dispatched. Count exactly what comes out of the crate." />

      {!selectedDeliveryId && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          {arrivable.length === 0 ? (
            <div style={{ fontSize: 13, color: T.faint }}>No deliveries currently in transit for {order.orderNo}.</div>
          ) : (
            arrivable.map((d) => (
              <div key={d.id} onClick={() => { setSelectedDeliveryId(d.id); setCounts({}); setSubmitted(false); }}
                style={{ padding: "12px 0", borderTop: `1px solid ${T.lineSoft}`, cursor: "pointer", display: "flex", justifyContent: "space-between" }}>
                <div style={{ fontSize: 13 }}>Run {String(d.runNo).padStart(2, "0")} — {d.carrier}</div>
                <Pill label="Arrived, uncounted" bg={T.pendingSoft} fg={T.pending} />
              </div>
            ))
          )}
        </div>
      )}

      {editing && !submitted && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
            Run {String(editing.runNo).padStart(2, "0")} — {editing.carrier}
          </div>
          <div style={{ fontSize: 11.5, color: T.faint, marginBottom: 14 }}>Docket {editing.docket}. Pick the parts in this crate and count them.</div>
          {linesInDelivery.map((l) => (
            <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${T.lineSoft}` }}>
              <div>
                <div style={{ fontFamily: font.mono, fontWeight: 600, fontSize: 13 }}>{l.partNo}</div>
                <div style={{ fontSize: 11.5, color: T.faint }}>{l.desc}</div>
              </div>
              <input type="number" min="0" placeholder="Qty received" value={counts[l.id] ?? ""}
                onChange={(e) => setCounts({ ...counts, [l.id]: Number(e.target.value) })}
                style={{ ...inputStyle, width: 96, textAlign: "right", fontFamily: font.mono, margin: 0 }} />
            </div>
          ))}
          <label style={{ ...labelStyle, marginTop: 16 }}>Counted by</label>
          <select value={countedBy} onChange={(e) => setCountedBy(e.target.value)} style={inputStyle}>
            {RECEIVERS.map((p) => <option key={p}>{p}</option>)}
          </select>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={() => setSelectedDeliveryId(null)} style={secondaryBtn}>Back</button>
            <button onClick={submit} style={primaryBtn}>Submit and lock</button>
          </div>
        </div>
      )}

      {submitted && editing && (
        <ConfirmBanner text={`Run ${String(editing.runNo).padStart(2, "0")} receipt logged. Any mismatch is now pinned on the master ledger.`}
          onDone={() => { setSelectedDeliveryId(null); setSubmitted(false); }} />
      )}
    </div>
  );
}

/* ------------------------- Shared bits --------------------------- */

function SectionHeader({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontFamily: font.display, fontWeight: 800, fontSize: 18 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: T.faint, marginTop: 3 }}>{note}</div>
    </div>
  );
}

function ConfirmBanner({ text, onDone }: { text: string; onDone: () => void }) {
  return (
    <div style={{ background: T.okSoft, border: `1px solid ${T.ok}33`, borderRadius: 10, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ fontSize: 13, color: T.ok }}>{text}</div>
      <button onClick={onDone} style={secondaryBtn}>Done</button>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", border: `1px solid ${T.line}`, borderRadius: 6,
  fontSize: 13, fontFamily: font.body, marginTop: 4, boxSizing: "border-box", background: "#FAFBFC",
};

const labelStyle: React.CSSProperties = { fontSize: 11, color: T.faint, textTransform: "uppercase", letterSpacing: 0.4, display: "block", marginTop: 10 };

const primaryBtn: React.CSSProperties = {
  background: T.navy, color: "#fff", border: "none", borderRadius: 6, padding: "9px 16px",
  fontSize: 13, fontWeight: 600, cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  background: "transparent", color: T.ink, border: `1px solid ${T.line}`, borderRadius: 6, padding: "9px 16px",
  fontSize: 13, fontWeight: 600, cursor: "pointer",
};
