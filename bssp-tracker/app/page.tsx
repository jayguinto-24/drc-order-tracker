import { getOrders, listPeople, listRecipients } from "@/lib/actions";
import OrderTracker from "@/app/OrderTracker";

// Orders change on every count submitted from the floor — never prerender/cache this page.
export const dynamic = "force-dynamic";

export default async function Page() {
  const [orders, people, recipients] = await Promise.all([getOrders(), listPeople(), listRecipients()]);
  return <OrderTracker initialOrders={orders} initialPeople={people} initialRecipients={recipients} />;
}
