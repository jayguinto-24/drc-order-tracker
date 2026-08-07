"use client";

import React, { useState } from "react";
import * as XLSX from "xlsx";
import {
  acceptOverSupply,
  addPerson,
  addRecipient,
  createImportOrder,
  createManualOrder,
  removePerson,
  removeRecipient,
  requestPoIncrease,
  startRun,
  submitRunDispatch,
  submitRunReceipt,
  updateJasonQty,
  updateLineQty,
} from "@/lib/actions";
import { deliveryDeltas, lineReconciliation, classifyAlerts } from "@/lib/recon";
import type {
  Alerts,
  CountMap,
  Delivery,
  DraftLine,
  NotifyRecipient,
  Order,
  OrdersMap,
  ParsedOrder,
  Person,
  PersonRole,
  ReconLine,
} from "@/lib/types";

/* =================================================================
   BSSP ORDER TRACKER
   Three-way blind reconciliation: Ordered (Brett) vs Dispatched
   (Border packing, blind) vs Received (DRC goods-in, blind).
   DRC and Jason (Border) both see the full master ledger. Data is
   persisted server-side; discrepancy and new-despatch emails fire
   from the server actions in lib/actions.ts.
   ================================================================= */

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700;800&family=Lato:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap');
`;

/* DRC Switchboards brand: primary red #CD1A30, charcoal/steel neutrals,
   Barlow Semi Condensed for headings and Lato for body — pulled from
   drcswitchboards.com.au's theme CSS. */
const T = {
  page: "#F1F1F1",
  panel: "#FFFFFF",
  ink: "#1E2124",
  steel: "#5B6166",
  faint: "#8A9096",
  line: "#DCDCDC",
  lineSoft: "#EBEBEB",
  navy: "#1E2124",
  navySoft: "#EDEDED",
  slate: "#797F84",
  slateLine: "rgba(255,255,255,0.28)",
  orange: "#CD1A30",
  orangeSoft: "#FBE7E9",
  ok: "#1F7A55",
  okSoft: "#E5F3EC",
  flag: "#CD1A30",
  flagSoft: "#FBE7E9",
  pending: "#A9760B",
  pendingSoft: "#FBF1DC",
};

const font = {
  display: "'Barlow Semi Condensed', sans-serif",
  body: "'Lato', sans-serif",
  mono: "'JetBrains Mono', monospace",
};

/* Used until someone adds real names on the Setup tab. */
const DEFAULT_PACKERS = ["Craig G", "Terry M", "Josh P"];
const DEFAULT_RECEIVERS = ["Owen N", "Bree C", "Grace T"];

const CARRIERS = ["BSSP Truck", "Mainfreight", "Other"];

/* ------------------------- Helpers --------------------------- */

/* Shared row-processor for both the plain CSV/TSV path and the XLS/XLSX path
   below — takes already-split rows of cells and does header detection +
   line parsing. Accepts a header row containing some form of: part,
   description, colour, qty. Column order and exact naming are flexible;
   anything unrecognised is skipped with a warning rather than silently
   guessed. */
function linesFromRows(rows: string[][]): ParsedOrder {
  const cleaned = rows.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some((c) => c.length > 0));
  if (cleaned.length < 2) return { lines: [], warnings: ["No data rows found below the header."] };

  const header = cleaned[0].map((h) => h.toLowerCase());
  const find = (...keys: string[]) => header.findIndex((h) => keys.some((k) => h.includes(k)));
  const idx = {
    partNo: find("part", "sku", "code", "item no", "item#", "product"),
    desc: find("desc", "item", "name"),
    colour: find("colour", "color", "finish"),
    qty: find("qty", "quantity", "ordered", "units", "amount", "each", "pcs", "count"),
  };

  const warnings: string[] = [];
  if (idx.partNo === -1) warnings.push("No 'part number' column found — using column 1.");
  if (idx.qty === -1) {
    warnings.push("No 'quantity' column found (looked for headers like Qty/Quantity/Units/Amount) — every line was skipped. Try the downloadable template below to be sure of the column names.");
    return { lines: [], warnings };
  }

  const lines: ParsedOrder["lines"] = [];
  cleaned.slice(1).forEach((cells, i) => {
    const partNo = cells[idx.partNo !== -1 ? idx.partNo : 0] || "";
    // Strip anything but digits/decimal/minus so "1,200", "$50", "12 units" etc. still parse.
    const qtyRaw = (cells[idx.qty] || "").replace(/[^0-9.-]/g, "");
    const qty = Number(qtyRaw);
    if (!partNo || !qtyRaw || Number.isNaN(qty) || qty <= 0) {
      warnings.push(`Row ${i + 2}: skipped — missing part number or a valid quantity.`);
      return;
    }
    lines.push({
      partNo,
      desc: idx.desc !== -1 ? cells[idx.desc] || "" : "",
      colour: idx.colour !== -1 ? cells[idx.colour] || "—" : "—",
      qtyOrdered: qty,
    });
  });

  return { lines, warnings };
}

/* Pasted or plain-text-uploaded CSV/TSV. */
function parseDelimitedOrder(text: string): ParsedOrder {
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter((r) => r.length > 0);
  if (rows.length === 0) return { lines: [], warnings: ["No data rows found below the header."] };
  const delim = rows[0].includes("\t") ? "\t" : ",";
  return linesFromRows(rows.map((r) => r.split(delim)));
}

/* .xls / .xlsx uploads — parsed client-side, no server round trip needed. */
function parseWorkbook(data: ArrayBuffer): ParsedOrder {
  const workbook = XLSX.read(data, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: "" });
  return linesFromRows(rows.map((r) => r.map((c) => String(c))));
}

/* Blank .xlsx with the exact headers the importer looks for, so uploads
   don't depend on guessing column names correctly. */
function downloadOrderTemplate() {
  const rows = [
    ["Part No", "Description", "Colour", "Qty"],
    ["SW-2400", "Side wall panel 2.4m", "Colorbond Monument", 40],
    ["EW-3000", "End wall panel 3.0m", "Colorbond Monument", 10],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Order");
  XLSX.writeFile(workbook, "order-template.xlsx");
}

/* ------------------------- Shell --------------------------- */

const ROLE_TABS = [
  { id: "drc", label: "DRC", tag: "Master · Ordering" },
  { id: "jason", label: "Jason", tag: "Master · Border" },
  { id: "packer", label: "Packing crew", tag: "Border · blind" },
  { id: "receiver", label: "Goods in", tag: "DRC · blind" },
  { id: "setup", label: "Setup", tag: "Admin" },
];

/* Demo-only access codes for the two master roles. This is a client-side
   gate for walkthroughs — the code ships in the bundle, so it is NOT real
   security. Production access control has to happen server-side. */
const MASTER_PINS: Record<string, string> = { drc: "1287", jason: "2471", setup: "1287" };

export default function OrderTracker({ initialOrders, initialPeople, initialRecipients }: {
  initialOrders: OrdersMap;
  initialPeople: Person[];
  initialRecipients: NotifyRecipient[];
}) {
  const [orders, setOrders] = useState<OrdersMap>(initialOrders);
  const [people, setPeople] = useState<Person[]>(initialPeople);
  const [recipients, setRecipients] = useState<NotifyRecipient[]>(initialRecipients);
  const [activeOrderNo, setActiveOrderNo] = useState(() => Object.keys(initialOrders)[0] || "");
  const [role, setRole] = useState("packer");
  const [unlocked, setUnlocked] = useState<Record<string, boolean>>({ drc: false, jason: false, setup: false });
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const order = orders[activeOrderNo];

  const packerNames = people.filter((p) => p.role === "packer").map((p) => p.name);
  const receiverNames = people.filter((p) => p.role === "receiver").map((p) => p.name);

  function mergeOrder(updated: Order) {
    setOrders((prev) => ({ ...prev, [updated.orderNo]: updated }));
  }
  function mergeOrders(updated: Order[]) {
    setOrders((prev) => {
      const next = { ...prev };
      updated.forEach((o) => { next[o.orderNo] = o; });
      return next;
    });
  }

  function requestRole(id: string) {
    if ((id === "drc" || id === "jason" || id === "setup") && !unlocked[id]) {
      setPendingRole(id);
    } else {
      setRole(id);
    }
  }

  function lockRole(id: string) {
    setUnlocked((u) => ({ ...u, [id]: false }));
    setRole("packer");
  }

  function unlockWith(id: string) {
    setUnlocked((u) => ({ ...u, [id]: true }));
    setRole(id);
    setPendingRole(null);
  }

  async function handleCreateManual(orderNo: string, lines: DraftLine[]) {
    const updated = await createManualOrder(orderNo, lines);
    mergeOrder(updated);
    setActiveOrderNo(updated.orderNo);
  }

  async function handleCreateImport(orderNo: string, lines: ParsedOrder["lines"]) {
    const updated = await createImportOrder(orderNo, lines);
    mergeOrder(updated);
    setActiveOrderNo(updated.orderNo);
  }

  async function handleStartRun(orderNos: string[], carrier: string, docket: string) {
    const updated = await startRun(orderNos, carrier, docket);
    mergeOrders(updated);
    return updated;
  }

  async function handleSubmitRunDispatch(entries: { orderNo: string; deliveryId: string; counts: CountMap }[], by: string) {
    const updated = await submitRunDispatch(entries, by);
    mergeOrders(updated);
    return updated;
  }

  async function handleSubmitRunReceipt(entries: { orderNo: string; deliveryId: string; counts: CountMap }[], by: string) {
    const updated = await submitRunReceipt(entries, by);
    mergeOrders(updated);
    return updated;
  }

  async function handleUpdateJasonQty(lineId: string, qty: number | null) {
    const updated = await updateJasonQty(activeOrderNo, lineId, qty);
    mergeOrder(updated);
  }

  async function handleUpdateLineQty(lineId: string, qty: number) {
    const updated = await updateLineQty(activeOrderNo, lineId, qty);
    mergeOrder(updated);
  }

  async function handleAcceptOverSupply(lineId: string) {
    const updated = await acceptOverSupply(activeOrderNo, lineId);
    mergeOrder(updated);
  }

  async function handleRequestPoIncrease(lineId: string) {
    await requestPoIncrease(activeOrderNo, lineId);
  }

  async function handleAddPerson(name: string, personRole: PersonRole) {
    const updated = await addPerson(name, personRole);
    setPeople(updated);
  }

  async function handleRemovePerson(id: string) {
    const updated = await removePerson(id);
    setPeople(updated);
  }

  async function handleAddRecipient(email: string, notifyOrderCreated: boolean, notifyDispatch: boolean, notifyDiscrepancy: boolean) {
    const updated = await addRecipient(email, notifyOrderCreated, notifyDispatch, notifyDiscrepancy);
    setRecipients(updated);
  }

  async function handleRemoveRecipient(id: string) {
    const updated = await removeRecipient(id);
    setRecipients(updated);
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
        {role === "drc" && (
          <>
            <OrderingView
              orders={orders}
              activeOrderNo={activeOrderNo}
              setActiveOrderNo={setActiveOrderNo}
              onCreateManual={handleCreateManual}
              onCreateImport={handleCreateImport}
            />
            {order && (
              <MasterView
                order={order}
                viewer="drc"
                onUpdateJasonQty={handleUpdateJasonQty}
                onUpdateLineQty={handleUpdateLineQty}
                onAcceptOverSupply={handleAcceptOverSupply}
                onRequestPoIncrease={handleRequestPoIncrease}
              />
            )}
          </>
        )}
        {role === "jason" && (order ? (
          <MasterView
            order={order}
            viewer="jason"
            onUpdateJasonQty={handleUpdateJasonQty}
            onUpdateLineQty={handleUpdateLineQty}
            onAcceptOverSupply={handleAcceptOverSupply}
            onRequestPoIncrease={handleRequestPoIncrease}
          />
        ) : (
          <EmptyState />
        ))}
        {role === "packer" && (
          <PackingView
            orders={orders}
            activeOrderNo={activeOrderNo}
            packerNames={packerNames.length > 0 ? packerNames : DEFAULT_PACKERS}
            onStartRun={handleStartRun}
            onSubmitRun={handleSubmitRunDispatch}
          />
        )}
        {role === "receiver" && (
          <ReceivingView
            orders={orders}
            activeOrderNo={activeOrderNo}
            receiverNames={receiverNames.length > 0 ? receiverNames : DEFAULT_RECEIVERS}
            onSubmitRun={handleSubmitRunReceipt}
          />
        )}
        {role === "setup" && (
          <SetupView
            people={people}
            recipients={recipients}
            onAddPerson={handleAddPerson}
            onRemovePerson={handleRemovePerson}
            onAddRecipient={handleAddRecipient}
            onRemoveRecipient={handleRemoveRecipient}
          />
        )}
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

function EmptyState() {
  return (
    <div style={{ border: `1px dashed ${T.line}`, borderRadius: 10, padding: 24, textAlign: "center", color: T.faint, fontSize: 13 }}>
      No orders yet. Ask DRC to create or import one from the DRC tab.
    </div>
  );
}

function AccessGateModal({ roleId, onCancel, onUnlock }: { roleId: string; onCancel: () => void; onUnlock: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const name = roleId === "drc" ? "DRC" : roleId === "setup" ? "Setup" : "Jason";

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
  const orderNos = Object.keys(orders);
  return (
    <div style={{ background: T.slate, borderBottom: `4px solid ${T.orange}` }}>
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "18px 24px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ background: T.panel, borderRadius: 6, padding: "6px 10px", display: "flex", alignItems: "center" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/drc-logo.png" alt="DRC Switchboards" style={{ height: 36, width: "auto", display: "block" }} />
            </div>
            <div style={{ width: 2, height: 36, background: T.orange }} />
            <div>
              <div style={{ fontFamily: font.display, fontWeight: 800, fontSize: 21, color: "#fff", letterSpacing: 0.4, textTransform: "uppercase" }}>
                Order Tracker
              </div>
              <div style={{ fontSize: 11.5, color: "#E4E6E8", marginTop: 1, letterSpacing: 0.3 }}>
                Three-way count reconciliation — DRC ⇄ Border
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {(role === "drc" || role === "jason" || role === "setup") && (
              <button onClick={() => onLock(role)} style={{
                background: "transparent", border: `1px solid ${T.slateLine}`, color: "#fff",
                borderRadius: 6, padding: "7px 12px", fontSize: 11.5, cursor: "pointer",
              }}>
                Lock {role === "drc" ? "DRC" : role === "setup" ? "Setup" : "Jason's"} view
              </button>
            )}
            <select
              value={activeOrderNo}
              onChange={(e) => setActiveOrderNo(e.target.value)}
              style={{
                background: "rgba(0,0,0,0.18)", color: "#fff", border: `1px solid ${T.slateLine}`, borderRadius: 6,
                padding: "8px 12px", fontFamily: font.mono, fontSize: 13, fontWeight: 600,
              }}
            >
              {orderNos.length === 0 && <option value="">No orders yet</option>}
              {orderNos.map((no) => (
                <option key={no} value={no} style={{ color: T.ink }}>{no}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, marginTop: 18, overflowX: "auto" }}>
          {ROLE_TABS.map((r) => {
            const active = role === r.id;
            const isMaster = r.id === "drc" || r.id === "jason" || r.id === "setup";
            const isLocked = isMaster && !unlocked[r.id];
            return (
              <button
                key={r.id}
                onClick={() => requestRole(r.id)}
                style={{
                  background: active ? T.panel : "transparent",
                  color: active ? T.orange : "#E4E6E8",
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
                  {isLocked && <LockGlyph color={active ? T.orange : "#E4E6E8"} />}
                </div>
                <div style={{ fontSize: 10.5, marginTop: 2, color: active ? T.steel : "#C7CACD", letterSpacing: 0.3, textTransform: "uppercase" }}>
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

function MasterView({ order, viewer, onUpdateJasonQty, onUpdateLineQty, onAcceptOverSupply, onRequestPoIncrease }: {
  order: Order;
  viewer: string;
  onUpdateJasonQty: (lineId: string, qty: number | null) => void;
  onUpdateLineQty: (lineId: string, qty: number) => void;
  onAcceptOverSupply: (lineId: string) => void;
  onRequestPoIncrease: (lineId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const recon = lineReconciliation(order);
  const alerts = classifyAlerts(order);
  const isJason = viewer === "jason";
  const isDrc = viewer === "drc";

  return (
    <div>
      <SummaryStrip order={order} recon={recon} />
      <DeliveryRail order={order} />
      <AlertsPanel alerts={alerts} isJason={isJason} />

      <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.line}`, fontFamily: font.display, fontWeight: 700, fontSize: 14 }}>
          Master ledger
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: T.navySoft, textAlign: "left" }}>
              {["Part", "Colour", "Ordered", "Jason count", "Dispatched", "Received", "Back order", "Status"].map((h) => (
                <th key={h} style={{ padding: "9px 14px", fontSize: 10.5, letterSpacing: 0.5, textTransform: "uppercase", color: T.steel, fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recon.map((l) => {
              const status = statusFor(l);
              const isOpen = expanded === l.id;
              const isOverSupplied = l.backOrder < 0 && !l.overSupplyAccepted;
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
                    <td style={{ padding: "10px 14px" }}>
                      <QtyEditCell qty={l.qtyOrdered} editable={isDrc} onCommit={(qty) => onUpdateLineQty(l.id, qty)} />
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <JasonQtyCell line={l} editable={isJason} onCommit={(qty) => onUpdateJasonQty(l.id, qty)} />
                    </td>
                    <td style={{ padding: "10px 14px", fontFamily: font.mono }}>{l.dispatched}</td>
                    <td style={{ padding: "10px 14px", fontFamily: font.mono }}>{l.received}</td>
                    <td style={{ padding: "10px 14px", fontFamily: font.mono, color: l.backOrder < 0 ? T.flag : l.backOrder > 0 ? T.pending : T.ok }}>
                      {l.backOrder > 0 ? `+${l.backOrder} owed` : l.backOrder < 0 ? `${Math.abs(l.backOrder)} over` : "0"}
                    </td>
                    <td style={{ padding: "10px 14px" }}><Pill {...status} /></td>
                  </tr>
                  {isOverSupplied && (
                    <tr>
                      <td colSpan={8} style={{ padding: "0 14px 12px", background: "#FAFBFC" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 12px", background: T.flagSoft, borderRadius: 8 }}>
                          <span style={{ fontSize: 12, color: T.flag }}>
                            {Math.abs(l.backOrder)} more dispatched than ordered — request a PO increase, or accept it as a no-charge over-supply.
                          </span>
                          <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); onRequestPoIncrease(l.id); }}
                              style={{ ...secondaryBtn, padding: "6px 10px", fontSize: 11.5 }}
                            >
                              Request PO increase
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); onAcceptOverSupply(l.id); }}
                              style={{ ...primaryBtn, padding: "6px 10px", fontSize: 11.5 }}
                            >
                              Accept as no-charge
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  {isOpen && (
                    <tr>
                      <td colSpan={8} style={{ padding: "0 14px 14px", background: "#FAFBFC" }}>
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
        {viewer === "drc" ? "DRC" : "Jason"}{" "}
        sees the complete picture — ordered, dispatched and received —
        exactly as agreed. Packers and goods-in never see the numbers they&apos;re checked against.
        {isJason ? " Jason count is your own tally of what the order should be — edit it inline, it doesn't change the PO." : ""}
        {isDrc ? " Ordered qty is editable here — use it to apply an agreed PO increase." : ""}
        {" "}Click any row for its per-delivery breakdown.
      </p>
    </div>
  );
}

function QtyEditCell({ qty, editable, onCommit }: {
  qty: number;
  editable: boolean;
  onCommit: (qty: number) => void;
}) {
  const [value, setValue] = useState(() => String(qty));
  const [synced, setSynced] = useState(qty);

  if (qty !== synced) {
    setSynced(qty);
    setValue(String(qty));
  }

  if (!editable) {
    return <span style={{ fontFamily: font.mono }}>{qty}</span>;
  }

  return (
    <input
      type="number"
      min="0"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const num = Number(value);
        if (value.trim() !== "" && !Number.isNaN(num) && num !== qty) onCommit(num);
        else setValue(String(qty));
      }}
      style={{ ...inputStyle, width: 70, margin: 0, textAlign: "right", fontFamily: font.mono }}
    />
  );
}

function JasonQtyCell({ line, editable, onCommit }: {
  line: ReconLine;
  editable: boolean;
  onCommit: (qty: number | null) => void;
}) {
  const toStr = (qty: number | null) => (qty === null || qty === undefined ? "" : String(qty));
  const [value, setValue] = useState(() => toStr(line.jasonQty));
  const [syncedJasonQty, setSyncedJasonQty] = useState(line.jasonQty);

  if (line.jasonQty !== syncedJasonQty) {
    setSyncedJasonQty(line.jasonQty);
    setValue(toStr(line.jasonQty));
  }

  if (!editable) {
    return <span style={{ fontFamily: font.mono }}>{line.jasonQty ?? "—"}</span>;
  }

  return (
    <input
      type="number"
      min="0"
      placeholder="—"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const num = value.trim() === "" ? null : Number(value);
        if (num !== (line.jasonQty ?? null)) onCommit(Number.isNaN(num) ? null : num);
      }}
      style={{ ...inputStyle, width: 84, margin: 0, textAlign: "right", fontFamily: font.mono }}
    />
  );
}

function statusFor(l: ReconLine): { label: string; bg: string; fg: string } {
  if (l.transitDelta && l.transitDelta !== 0) return { label: "Transit loss", bg: T.flagSoft, fg: T.flag };
  if (l.backOrder < 0 && l.overSupplyAccepted) return { label: "Over-supply accepted", bg: T.okSoft, fg: T.ok };
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

function AlertsPanel({ alerts, isJason }: { alerts: Alerts; isJason: boolean }) {
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

/* ------------------------- Ordering view (DRC) --------------------------- */

function OrderingView({ orders, activeOrderNo, setActiveOrderNo, onCreateManual, onCreateImport }: {
  orders: OrdersMap;
  activeOrderNo: string;
  setActiveOrderNo: (no: string) => void;
  onCreateManual: (orderNo: string, lines: DraftLine[]) => Promise<void>;
  onCreateImport: (orderNo: string, lines: ParsedOrder["lines"]) => Promise<void>;
}) {
  const [mode, setMode] = useState("manual"); // 'manual' | 'import'
  const [newOrderNo, setNewOrderNo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ partNo: "", desc: "", colour: "", qty: "" }]);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const [importOrderNo, setImportOrderNo] = useState("");
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ParsedOrder | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  function addLine() {
    setLines([...lines, { partNo: "", desc: "", colour: "", qty: "" }]);
  }
  function updateLine(i: number, field: keyof DraftLine, val: string) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, [field]: val } : l)));
  }

  async function createOrder() {
    setManualError(null);
    setManualBusy(true);
    try {
      await onCreateManual(newOrderNo, lines);
      setNewOrderNo("");
      setLines([{ partNo: "", desc: "", colour: "", qty: "" }]);
    } catch (err) {
      setManualError(err instanceof Error ? err.message : "Couldn't create the order.");
    } finally {
      setManualBusy(false);
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    if (!importOrderNo) setImportOrderNo(file.name.replace(/\.(csv|txt|tsv|xlsx|xls)$/i, ""));

    const isSpreadsheet = /\.(xlsx|xls)$/i.test(file.name);
    const reader = new FileReader();
    if (isSpreadsheet) {
      reader.onload = (evt) => {
        setRawText("");
        setPreview(parseWorkbook(evt.target?.result as ArrayBuffer));
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (evt) => {
        const text = String(evt.target?.result);
        setRawText(text);
        setPreview(parseDelimitedOrder(text));
      };
      reader.readAsText(file);
    }
  }

  function handlePasteChange(val: string) {
    setRawText(val);
    setPreview(val.trim() ? parseDelimitedOrder(val) : null);
  }

  async function commitImport() {
    if (!importOrderNo.trim() || !preview || preview.lines.length === 0) return;
    setImportError(null);
    setImportBusy(true);
    try {
      await onCreateImport(importOrderNo, preview.lines);
      setImportOrderNo("");
      setRawText("");
      setFileName("");
      setPreview(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Couldn't import the order.");
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <div>
      <SectionHeader title="Orders" note="Create an order by hand, or import one from a spreadsheet export — any order number, any file." />

      <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, overflow: "hidden", marginBottom: 20 }}>
        {Object.keys(orders).length === 0 && (
          <div style={{ padding: "14px 16px", fontSize: 12.5, color: T.faint }}>No orders yet — create or import one below.</div>
        )}
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
          {manualError && <div style={{ fontSize: 11.5, color: T.flag, marginTop: 10 }}>{manualError}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={addLine} style={secondaryBtn}>+ Add line</button>
            <button onClick={createOrder} disabled={manualBusy} style={{ ...primaryBtn, opacity: manualBusy ? 0.6 : 1 }}>
              {manualBusy ? "Creating…" : "Create order"}
            </button>
          </div>
        </div>
      )}

      {mode === "import" && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: "0 10px 10px 10px", padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 12.5, color: T.steel }}>Not sure of the column layout?</span>
            <button type="button" onClick={downloadOrderTemplate} style={{ ...secondaryBtn, padding: "6px 10px", fontSize: 11.5 }}>
              Download template
            </button>
          </div>

          <label style={labelStyle}>Order number</label>
          <input placeholder="e.g. BSSP-102" value={importOrderNo} onChange={(e) => setImportOrderNo(e.target.value)} style={inputStyle} />

          <label style={labelStyle}>Upload a .csv or .xlsx export</label>
          <input type="file" accept=".csv,.txt,.tsv,.xlsx,.xls" onChange={handleFile}
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
                    {preview.lines.map((l, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${T.lineSoft}` }}>
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

          {importError && <div style={{ fontSize: 11.5, color: T.flag, marginTop: 10 }}>{importError}</div>}

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              onClick={commitImport}
              disabled={!preview || preview.lines.length === 0 || !importOrderNo.trim() || importBusy}
              style={{ ...primaryBtn, opacity: (!preview || preview.lines.length === 0 || !importOrderNo.trim() || importBusy) ? 0.45 : 1 }}
            >
              {importBusy ? "Importing…" : "Create order from import"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------- Setup (admin) --------------------------- */

function SetupView({ people, recipients, onAddPerson, onRemovePerson, onAddRecipient, onRemoveRecipient }: {
  people: Person[];
  recipients: NotifyRecipient[];
  onAddPerson: (name: string, role: PersonRole) => Promise<void>;
  onRemovePerson: (id: string) => Promise<void>;
  onAddRecipient: (email: string, notifyOrderCreated: boolean, notifyDispatch: boolean, notifyDiscrepancy: boolean) => Promise<void>;
  onRemoveRecipient: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [personRole, setPersonRole] = useState<PersonRole>("packer");
  const [personBusy, setPersonBusy] = useState(false);
  const [personError, setPersonError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [notifyOrderCreated, setNotifyOrderCreated] = useState(true);
  const [notifyDispatch, setNotifyDispatch] = useState(true);
  const [notifyDiscrepancy, setNotifyDiscrepancy] = useState(true);
  const [recipientBusy, setRecipientBusy] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  async function submitPerson() {
    setPersonError(null);
    setPersonBusy(true);
    try {
      await onAddPerson(name, personRole);
      setName("");
    } catch (err) {
      setPersonError(err instanceof Error ? err.message : "Couldn't add that person.");
    } finally {
      setPersonBusy(false);
    }
  }

  async function submitRecipient() {
    setRecipientError(null);
    setRecipientBusy(true);
    try {
      await onAddRecipient(email, notifyOrderCreated, notifyDispatch, notifyDiscrepancy);
      setEmail("");
    } catch (err) {
      setRecipientError(err instanceof Error ? err.message : "Couldn't add that recipient.");
    } finally {
      setRecipientBusy(false);
    }
  }

  const packers = people.filter((p) => p.role === "packer");
  const receivers = people.filter((p) => p.role === "receiver");

  return (
    <div>
      <SectionHeader title="Setup" note="Manage who shows up in the Counted-by dropdowns, and who gets email notifications." />

      <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18, marginBottom: 20 }}>
        <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>People</div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 8 }}>
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          <select value={personRole} onChange={(e) => setPersonRole(e.target.value as PersonRole)} style={inputStyle}>
            <option value="packer">Packer</option>
            <option value="receiver">Receiver</option>
          </select>
          <button onClick={submitPerson} disabled={personBusy} style={{ ...primaryBtn, opacity: personBusy ? 0.6 : 1, marginTop: 4 }}>
            {personBusy ? "Adding…" : "+ Add"}
          </button>
        </div>
        {personError && <div style={{ fontSize: 11.5, color: T.flag, marginTop: 8 }}>{personError}</div>}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          <div>
            <div style={{ fontSize: 10.5, color: T.faint, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Packers</div>
            {packers.length === 0 && <div style={{ fontSize: 12, color: T.faint }}>None yet — using default names for now.</div>}
            {packers.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: `1px solid ${T.lineSoft}`, fontSize: 13 }}>
                {p.name}
                <button onClick={() => onRemovePerson(p.id)} style={{ ...secondaryBtn, padding: "3px 8px", fontSize: 11 }}>Remove</button>
              </div>
            ))}
          </div>
          <div>
            <div style={{ fontSize: 10.5, color: T.faint, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Receivers</div>
            {receivers.length === 0 && <div style={{ fontSize: 12, color: T.faint }}>None yet — using default names for now.</div>}
            {receivers.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: `1px solid ${T.lineSoft}`, fontSize: 13 }}>
                {p.name}
                <button onClick={() => onRemovePerson(p.id)} style={{ ...secondaryBtn, padding: "3px 8px", fontSize: 11 }}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
        <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Notification recipients</div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr auto auto auto auto", gap: 8, alignItems: "center" }}>
          <input placeholder="name@drcswitchboards.com.au" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
            <input type="checkbox" checked={notifyOrderCreated} onChange={(e) => setNotifyOrderCreated(e.target.checked)} /> New order
          </label>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
            <input type="checkbox" checked={notifyDispatch} onChange={(e) => setNotifyDispatch(e.target.checked)} /> New despatch
          </label>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
            <input type="checkbox" checked={notifyDiscrepancy} onChange={(e) => setNotifyDiscrepancy(e.target.checked)} /> Discrepancy
          </label>
          <button onClick={submitRecipient} disabled={recipientBusy} style={{ ...primaryBtn, opacity: recipientBusy ? 0.6 : 1, marginTop: 4 }}>
            {recipientBusy ? "Adding…" : "+ Add"}
          </button>
        </div>
        {recipientError && <div style={{ fontSize: 11.5, color: T.flag, marginTop: 8 }}>{recipientError}</div>}

        <div style={{ marginTop: 14 }}>
          {recipients.length === 0 && (
            <div style={{ fontSize: 12, color: T.faint }}>
              None yet — falling back to the NOTIFY_ORDER_EMAILS / NOTIFY_DISPATCH_EMAILS / NOTIFY_DISCREPANCY_EMAILS environment variables.
            </div>
          )}
          {recipients.map((r) => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: `1px solid ${T.lineSoft}`, fontSize: 13 }}>
              <div>
                <div>{r.email}</div>
                <div style={{ fontSize: 11, color: T.faint }}>
                  {[r.notifyOrderCreated && "New order", r.notifyDispatch && "New despatch", r.notifyDiscrepancy && "Discrepancy"].filter(Boolean).join(" · ") || "No alerts selected"}
                </div>
              </div>
              <button onClick={() => onRemoveRecipient(r.id)} style={{ ...secondaryBtn, padding: "3px 8px", fontSize: 11 }}>Remove</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------- Packing view (blind) --------------------------- */

function PackingView({ orders, activeOrderNo, packerNames, onStartRun, onSubmitRun }: {
  orders: OrdersMap;
  activeOrderNo: string;
  packerNames: string[];
  onStartRun: (orderNos: string[], carrier: string, docket: string) => Promise<Order[]>;
  onSubmitRun: (entries: { orderNo: string; deliveryId: string; counts: CountMap }[], by: string) => Promise<Order[]>;
}) {
  const order = orders[activeOrderNo];
  const orderNos = Object.keys(orders);

  const [creating, setCreating] = useState(false);
  const [pickedOrderNos, setPickedOrderNos] = useState<string[]>([]);
  const [carrier, setCarrier] = useState(CARRIERS[0]);
  const [carrierOther, setCarrierOther] = useState("");
  const [docket, setDocket] = useState("");
  const [runEntries, setRunEntries] = useState<{ orderNo: string; deliveryId: string }[] | null>(null);
  const [counts, setCounts] = useState<CountMap>({});
  const [countedBy, setCountedBy] = useState(packerNames[0] ?? "");
  const [submitted, setSubmitted] = useState<{ orderNo: string; runNo: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDeliveries = order ? order.deliveries.filter((d) => d.status === "draft") : [];

  function openCreating() {
    setPickedOrderNos(activeOrderNo ? [activeOrderNo] : []);
    setCarrier(CARRIERS[0]);
    setCarrierOther("");
    setDocket("");
    setError(null);
    setCreating(true);
  }

  function togglePicked(no: string) {
    setPickedOrderNos((prev) => (prev.includes(no) ? prev.filter((n) => n !== no) : [...prev, no]));
  }

  async function startNewRun() {
    if (pickedOrderNos.length === 0) {
      setError("Pick at least one order.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const carrierName = carrier === "Other" ? carrierOther || "Other" : carrier;
      const updated = await onStartRun(pickedOrderNos, carrierName, docket);
      const entries = updated.map((o) => {
        const newest = o.deliveries.reduce((a, b) => (b.runNo > a.runNo ? b : a));
        return { orderNo: o.orderNo, deliveryId: newest.id };
      });
      setRunEntries(entries);
      setCreating(false);
      setCounts({});
      setSubmitted(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start a new dispatch.");
    } finally {
      setBusy(false);
    }
  }

  function continueDraft(deliveryId: string) {
    setRunEntries([{ orderNo: activeOrderNo, deliveryId }]);
    setCounts({});
    setSubmitted(null);
  }

  function reset() {
    setRunEntries(null);
    setSubmitted(null);
  }

  async function submit() {
    if (!runEntries) return;
    setError(null);
    setBusy(true);
    try {
      const entries = runEntries.map((e) => {
        const o = orders[e.orderNo];
        const lineIds = new Set(o.lines.map((l) => l.id));
        const entryCounts: CountMap = {};
        Object.entries(counts).forEach(([lineId, qty]) => {
          if (lineIds.has(lineId)) entryCounts[lineId] = qty;
        });
        return { orderNo: e.orderNo, deliveryId: e.deliveryId, counts: entryCounts };
      });
      const updated = await onSubmitRun(entries, countedBy);
      setSubmitted(entries.map((e) => {
        const o = updated.find((u) => u.orderNo === e.orderNo)!;
        const d = o.deliveries.find((dd) => dd.id === e.deliveryId)!;
        return { orderNo: e.orderNo, runNo: d.runNo };
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit this dispatch.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionHeader title="Border packing — blind count" note="You see part numbers only. Ordered quantities and back orders are hidden — count exactly what leaves the bench." />

      {!runEntries && !creating && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            {order ? <>Start a new delivery run for <strong>{order.orderNo}</strong> — or add other orders to the same run — or continue one in progress.</> : "Pick an order from the top bar to get started."}
          </div>
          <button onClick={openCreating} style={primaryBtn}>+ New dispatch</button>
          {openDeliveries.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {openDeliveries.map((d) => (
                <div key={d.id} onClick={() => continueDraft(d.id)} style={{ padding: "10px 0", borderTop: `1px solid ${T.lineSoft}`, cursor: "pointer", fontSize: 13 }}>
                  Run {String(d.runNo).padStart(2, "0")} — {d.carrier} (in progress)
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {creating && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>New dispatch</div>

          <label style={labelStyle}>Orders on this run</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
            {orderNos.map((no) => (
              <label key={no} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={pickedOrderNos.includes(no)} onChange={() => togglePicked(no)} />
                {no}
              </label>
            ))}
          </div>

          <label style={labelStyle}>Carrier</label>
          <select value={carrier} onChange={(e) => setCarrier(e.target.value)} style={inputStyle}>
            {CARRIERS.map((c) => <option key={c}>{c}</option>)}
          </select>
          {carrier === "Other" && (
            <input value={carrierOther} onChange={(e) => setCarrierOther(e.target.value)} placeholder="Carrier name" style={inputStyle} />
          )}

          <label style={labelStyle}>Docket number (optional)</label>
          <input value={docket} onChange={(e) => setDocket(e.target.value)} style={inputStyle} placeholder="—" />
          {error && <div style={{ fontSize: 11.5, color: T.flag, marginTop: 10 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={() => setCreating(false)} style={secondaryBtn}>Cancel</button>
            <button onClick={startNewRun} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Starting…" : "Start crate count"}
            </button>
          </div>
        </div>
      )}

      {runEntries && !submitted && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          {runEntries.map((entry) => {
            const o = orders[entry.orderNo];
            const d = o?.deliveries.find((dd) => dd.id === entry.deliveryId);
            if (!o || !d) return null;
            return (
              <div key={entry.deliveryId} style={{ marginBottom: 18 }}>
                <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                  {runEntries.length > 1 ? `${o.orderNo} — ` : ""}Run {String(d.runNo).padStart(2, "0")} — {d.carrier}
                </div>
                <div style={{ fontSize: 11.5, color: T.faint, marginBottom: 10 }}>Docket {d.docket}</div>
                {o.lines.map((l) => (
                  <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${T.lineSoft}` }}>
                    <div>
                      <div style={{ fontFamily: font.mono, fontWeight: 600, fontSize: 13 }}>{l.partNo}</div>
                      <div style={{ fontSize: 11.5, color: T.faint }}>{l.desc}</div>
                    </div>
                    <TallyQtyInput key={`${d.id}-${l.id}`} placeholder="Qty packed"
                      onChange={(total) => setCounts((prev) => ({ ...prev, [l.id]: total }))} />
                  </div>
                ))}
              </div>
            );
          })}
          <label style={{ ...labelStyle, marginTop: 4 }}>Counted by</label>
          <select value={countedBy} onChange={(e) => setCountedBy(e.target.value)} style={inputStyle}>
            {packerNames.map((p) => <option key={p}>{p}</option>)}
          </select>
          {error && <div style={{ fontSize: 11.5, color: T.flag, marginTop: 10 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={reset} style={secondaryBtn}>Back</button>
            <button onClick={submit} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Submitting…" : "Submit and lock"}
            </button>
          </div>
        </div>
      )}

      {submitted && (
        <ConfirmBanner
          text={`${submitted.map((s) => `${s.orderNo} run ${String(s.runNo).padStart(2, "0")}`).join(", ")} submitted and locked. It's now visible to DRC and Jason on the master ledger.`}
          onDone={reset}
        />
      )}
    </div>
  );
}

/* Small "add multiple counts, they sum" input — for stock counted in layers
   (e.g. different quantities on each level of a crate). Resets whenever its
   `key` changes (callers key it per delivery+line so switching runs clears it). */
function TallyQtyInput({ onChange, placeholder }: { onChange: (total: number) => void; placeholder: string }) {
  const [entries, setEntries] = useState<number[]>([]);
  const [draft, setDraft] = useState("");

  function commitDraft() {
    const n = Number(draft);
    if (draft.trim() === "" || Number.isNaN(n)) return;
    const next = [...entries, n];
    setEntries(next);
    setDraft("");
    onChange(next.reduce((a, b) => a + b, 0));
  }

  function removeEntry(i: number) {
    const next = entries.filter((_, idx) => idx !== i);
    setEntries(next);
    onChange(next.reduce((a, b) => a + b, 0));
  }

  const total = entries.reduce((a, b) => a + b, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <div style={{ display: "flex", gap: 4 }}>
        <input
          type="number"
          min="0"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft();
            }
          }}
          onBlur={commitDraft}
          style={{ ...inputStyle, width: 90, textAlign: "right", fontFamily: font.mono, margin: 0 }}
        />
        <button type="button" onClick={commitDraft} style={{ ...secondaryBtn, padding: "6px 10px", fontSize: 12 }}>+</button>
      </div>
      {entries.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "flex-end", maxWidth: 200 }}>
          {entries.map((n, i) => (
            <span key={i} onClick={() => removeEntry(i)} title="Click to remove"
              style={{ fontFamily: font.mono, fontSize: 11, background: T.lineSoft, borderRadius: 4, padding: "2px 6px", cursor: "pointer" }}>
              {n} ×
            </span>
          ))}
          <span style={{ fontFamily: font.mono, fontWeight: 700, fontSize: 12 }}>= {total}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------- Receiving view (blind) --------------------------- */

function ReceivingView({ orders, activeOrderNo, receiverNames, onSubmitRun }: {
  orders: OrdersMap;
  activeOrderNo: string;
  receiverNames: string[];
  onSubmitRun: (entries: { orderNo: string; deliveryId: string; counts: CountMap }[], by: string) => Promise<Order[]>;
}) {
  const order = orders[activeOrderNo];
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [counts, setCounts] = useState<CountMap>({});
  const [countedBy, setCountedBy] = useState(receiverNames[0] ?? "");
  const [submitted, setSubmitted] = useState<{ orderNo: string; runNo: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const arrivable = order ? order.deliveries.filter((d) => d.status === "dispatched") : [];
  const selectedDelivery = order?.deliveries.find((d) => d.id === selectedDeliveryId);

  // If this delivery is part of a multi-order run, pull in the sibling
  // deliveries (other orders, same run) so they're received together too.
  const runEntries: { orderNo: string; delivery: Delivery }[] = [];
  if (selectedDelivery) {
    if (selectedDelivery.runId) {
      Object.values(orders).forEach((o) => {
        o.deliveries.forEach((d) => {
          if (d.runId === selectedDelivery.runId && d.status === "dispatched") runEntries.push({ orderNo: o.orderNo, delivery: d });
        });
      });
    } else {
      runEntries.push({ orderNo: activeOrderNo, delivery: selectedDelivery });
    }
  }

  function select(deliveryId: string) {
    setSelectedDeliveryId(deliveryId);
    setCounts({});
    setSubmitted(null);
  }

  function reset() {
    setSelectedDeliveryId(null);
    setSubmitted(null);
  }

  async function submit() {
    if (runEntries.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const entries = runEntries.map(({ orderNo, delivery }) => {
        const dispatchedIds = new Set(Object.keys(delivery.dispatch?.counts ?? {}));
        const entryCounts: CountMap = {};
        Object.entries(counts).forEach(([lineId, qty]) => {
          if (dispatchedIds.has(lineId)) entryCounts[lineId] = qty;
        });
        return { orderNo, deliveryId: delivery.id, counts: entryCounts };
      });
      const updated = await onSubmitRun(entries, countedBy);
      setSubmitted(entries.map((e) => {
        const o = updated.find((u) => u.orderNo === e.orderNo)!;
        const d = o.deliveries.find((dd) => dd.id === e.deliveryId)!;
        return { orderNo: e.orderNo, runNo: d.runNo };
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit this receipt.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionHeader title="DRC goods-in — blind count" note="You see which delivery arrived, not what was dispatched. Count exactly what comes out of the crate." />

      {!selectedDeliveryId && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          {!order || arrivable.length === 0 ? (
            <div style={{ fontSize: 13, color: T.faint }}>No deliveries currently in transit{order ? ` for ${order.orderNo}` : ""}.</div>
          ) : (
            arrivable.map((d) => (
              <div key={d.id} onClick={() => select(d.id)}
                style={{ padding: "12px 0", borderTop: `1px solid ${T.lineSoft}`, cursor: "pointer", display: "flex", justifyContent: "space-between" }}>
                <div style={{ fontSize: 13 }}>Run {String(d.runNo).padStart(2, "0")} — {d.carrier}</div>
                <Pill label="Arrived, uncounted" bg={T.pendingSoft} fg={T.pending} />
              </div>
            ))
          )}
        </div>
      )}

      {runEntries.length > 0 && !submitted && (
        <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18 }}>
          {runEntries.map(({ orderNo, delivery }) => {
            const o = orders[orderNo];
            const linesInDelivery = o.lines.filter((l) => delivery.dispatch?.counts[l.id] !== undefined);
            return (
              <div key={delivery.id} style={{ marginBottom: 18 }}>
                <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                  {runEntries.length > 1 ? `${orderNo} — ` : ""}Run {String(delivery.runNo).padStart(2, "0")} — {delivery.carrier}
                </div>
                <div style={{ fontSize: 11.5, color: T.faint, marginBottom: 10 }}>Docket {delivery.docket}. Pick the parts in this crate and count them.</div>
                {linesInDelivery.map((l) => (
                  <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${T.lineSoft}` }}>
                    <div>
                      <div style={{ fontFamily: font.mono, fontWeight: 600, fontSize: 13 }}>{l.partNo}</div>
                      <div style={{ fontSize: 11.5, color: T.faint }}>{l.desc}</div>
                    </div>
                    <TallyQtyInput key={`${delivery.id}-${l.id}`} placeholder="Qty received"
                      onChange={(total) => setCounts((prev) => ({ ...prev, [l.id]: total }))} />
                  </div>
                ))}
              </div>
            );
          })}
          <label style={{ ...labelStyle, marginTop: 4 }}>Counted by</label>
          <select value={countedBy} onChange={(e) => setCountedBy(e.target.value)} style={inputStyle}>
            {receiverNames.map((p) => <option key={p}>{p}</option>)}
          </select>
          {error && <div style={{ fontSize: 11.5, color: T.flag, marginTop: 10 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={reset} style={secondaryBtn}>Back</button>
            <button onClick={submit} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Submitting…" : "Submit and lock"}
            </button>
          </div>
        </div>
      )}

      {submitted && (
        <ConfirmBanner
          text={`${submitted.map((s) => `${s.orderNo} run ${String(s.runNo).padStart(2, "0")}`).join(", ")} receipt logged. Any mismatch is now pinned on the master ledger.`}
          onDone={reset}
        />
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
