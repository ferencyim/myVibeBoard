// Child-process entry used by concurrency tests (bundled with esbuild, run with plain node).
import { migrateOwner, openVibeDb, publishEvent, type Owner } from "../../db";

const [mode, dbPath, arg1] = process.argv.slice(2) as [string, string, string];
const db = openVibeDb({ path: dbPath });

if (mode === "migrate") {
  migrateOwner(db, arg1 as Owner);
} else if (mode === "events") {
  migrateOwner(db, "core");
  for (let i = 0; i < Number(arg1); i++) {
    publishEvent(db, {
      type: "session.compacted",
      payload: { sessionId: String(i) },
      dedupeKey: `${process.pid}:${i}`,
    });
  }
}
db.close();
