// Optional demo data — run with `npm run db:seed` after DATABASE_URL is set
// and the schema has been pushed (`npx prisma db push`).
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const existing = await prisma.order.findUnique({ where: { orderNo: "BSSP-087" } });
  if (existing) {
    console.log("BSSP-087 already exists — skipping seed.");
    return;
  }

  const order = await prisma.order.create({
    data: {
      orderNo: "BSSP-087",
      status: "open",
      orderDate: new Date("2026-01-12"),
      totalExGst: 12234.63,
      source: "manual",
      lines: {
        create: [
          { partNo: "SW-2400", desc: "Side wall panel 2.4m", colour: "Colorbond Monument", qtyOrdered: 40 },
          { partNo: "EW-3000", desc: "End wall panel 3.0m", colour: "Colorbond Monument", qtyOrdered: 10 },
          { partNo: "RF-6000", desc: "Roof sheet 6.0m", colour: "Zincalume", qtyOrdered: 24 },
          { partNo: "FL-BRK", desc: "Flashing bracket kit", colour: "—", qtyOrdered: 60 },
          { partNo: "DR-HNG", desc: "Door hinge set", colour: "Powder white", qtyOrdered: 8 },
        ],
      },
    },
    include: { lines: true },
  });

  const byPart = Object.fromEntries(order.lines.map((l) => [l.partNo, l.id]));

  await prisma.delivery.create({
    data: {
      orderId: order.id,
      runNo: 1,
      carrier: "BSSP Truck",
      docket: "BT-4471",
      status: "received",
      dispatchBy: "Craig G",
      dispatchCounts: { [byPart["SW-2400"]]: 40, [byPart["EW-3000"]]: 6, [byPart["RF-6000"]]: 24, [byPart["FL-BRK"]]: 30, [byPart["DR-HNG"]]: 8 },
      receiptBy: "Owen N",
      receiptCounts: { [byPart["SW-2400"]]: 40, [byPart["EW-3000"]]: 6, [byPart["RF-6000"]]: 21, [byPart["FL-BRK"]]: 30, [byPart["DR-HNG"]]: 8 },
    },
  });

  await prisma.delivery.create({
    data: {
      orderId: order.id,
      runNo: 2,
      carrier: "MF",
      docket: "—",
      status: "received",
      dispatchBy: "Craig G",
      dispatchCounts: { [byPart["EW-3000"]]: 5, [byPart["FL-BRK"]]: 30 },
      receiptBy: "Bree C",
      receiptCounts: { [byPart["EW-3000"]]: 5, [byPart["FL-BRK"]]: 30 },
    },
  });

  await prisma.delivery.create({
    data: {
      orderId: order.id,
      runNo: 3,
      carrier: "BSSP Truck",
      docket: "BT-4502",
      status: "dispatched",
      dispatchBy: "Craig G",
      dispatchCounts: { [byPart["RF-6000"]]: 0 },
    },
  });

  await prisma.order.create({
    data: {
      orderNo: "BSSP-091",
      status: "open",
      orderDate: new Date("2026-02-03"),
      totalExGst: 4310.0,
      source: "manual",
      lines: {
        create: [
          { partNo: "SW-2400", desc: "Side wall panel 2.4m", colour: "Colorbond Woodland Grey", qtyOrdered: 16 },
          { partNo: "RF-4500", desc: "Roof sheet 4.5m", colour: "Zincalume", qtyOrdered: 12 },
        ],
      },
    },
  });

  console.log("Seeded BSSP-087 and BSSP-091.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
