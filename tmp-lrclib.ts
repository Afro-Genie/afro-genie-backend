import "dotenv/config";
import { LrcLibProvider } from "./src/services/lyricsProviders/lrclibProvider.ts";
async function main(){
  const p = new LrcLibProvider("test");
  const r = await p.search("Adekunle Gold","Pansa Pansa");
  console.log('search', r?.[0]);
  if(r?.[0]) console.log('sync', !!(await p.fetchLyricsWithSync(r[0].trackId)).plain || !!(await p.fetchLyricsWithSync(r[0].trackId)).synced);
}
main().catch(e=>{console.error(e.name,e.message); process.exit(1)});
