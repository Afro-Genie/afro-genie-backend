const Redis = require('ioredis');
const url = process.env.OLD_REDIS_URL;
const r = new Redis(url, { lazyConnect:true, connectTimeout:5000, maxRetriesPerRequest:1 });
(async()=>{
  await r.connect();
  let cursor='0'; let bull=0; let checked=0; const examples=[];
  do {
    const [next, keys] = await r.scan(cursor,'COUNT',500);
    cursor=next;
    for (const k of keys) {
      if (!k.startsWith('bull:')) continue;
      bull++; checked++;
      const t = await r.type(k);
      let size = 0;
      if (t==='hash') size = await r.hlen(k);
      else if (t==='zset') size = await r.zcard(k);
      else if (t==='list') size = await r.llen(k);
      else if (t==='set') size = await r.scard(k);
      else if (t==='string') size = 1;
      if (size===0 || (t==='hash' && size<=1)) examples.push({k,t,size});
    }
  } while(cursor!=='0');
  console.log(JSON.stringify({bull, examples: examples.slice(0,30)}));
  await r.quit();
})().catch(e=>{console.error(e.message); process.exit(1)});
