/** Print the last N closed candles, same format as `research candles` (cross-language check). */
import { loadEnv } from "../src/config.js";
import { connectDb, loadRecentCandles } from "../src/db.js";

const [symbol = "BTCUSDT", tf = "15m", last = "5"] = process.argv.slice(2);
const env = loadEnv();
const sql = connectDb(env.DATABASE_URL);
const g = (x: number) => Number(x.toPrecision(8)).toString();
for (const c of await loadRecentCandles(sql, symbol, tf, Number(last))) {
  console.log(`${c.openTime.toISOString().replace(".000Z", "+00:00")} o=${g(c.open)} h=${g(c.high)} l=${g(c.low)} c=${g(c.close)} v=${g(c.volume)}`);
}
await sql.end();
