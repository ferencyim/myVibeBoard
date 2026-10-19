// Child-process entry used by concurrency tests (bundled with esbuild, run with plain node).
import { createVibeStore, migrateOwner, openVibeDb, publishEvent, type Owner } from "../../db";

const [mode, dbPath, arg1, arg2] = process.argv.slice(2) as [string, string, string, string];
const db = openVibeDb({ path: dbPath });

if (mode === "migrate") {
  migrateOwner(db, arg1 as Owner);
} else if (mode === "cards") {
  // arg1 = project id, arg2 = count
  migrateOwner(db, "core");
  const store = createVibeStore(db);
  for (let i = 0; i < Number(arg2); i++) {
    const card = store.cards.create({ projectId: arg1, title: `card ${process.pid}-${i}` });
    store.cards.update(card.id, { description: `edited by ${process.pid}` });
  }
} else if (mode === "events") {
  migrateOwner(db, "core");
  for (let i = 0; i < Number(arg1); i++) {
    publishEvent(db, {
      type: "plan.updated",
      payload: { version: i },
      dedupeKey: `${process.pid}:${i}`,
    });
  }
}
db.close();
