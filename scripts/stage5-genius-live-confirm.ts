import { get } from 'node:https';
import { extractLyricsFromDataContainerHtml, extractLyricsFromLegacyContainerHtml, extractLyricsFromPreloadedState } from '../src/services/lyricsProviders/geniusProvider';

function fetchPage(url: string): Promise<{ status: number; html: string }> {
  return new Promise((resolve, reject) => {
    const req = get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Connection: 'close',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ status: res.statusCode ?? -1, html: '' });
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: 200, html: body }));
      },
    );
    req.setTimeout(20000, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

(async () => {
  const url = 'https://genius.com/Burna-boy-city-boys-lyrics';
  const { status, html } = await fetchPage(url);
  console.log(`status=${status}`);
  if (status !== 200) {
    console.log('LIVE_PAGE_CONFIRM=FAILED_STATUS');
    process.exit(1);
  }
  console.log(`bytes=${html.length}`);
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
  console.log(`title=${JSON.stringify(title)}`);
  const hasLyricMarkup = /data-lyrics-container="true"|Lyrics__Container|__PRELOADED_STATE__/.test(html);
  const isCloudflareWall = /just a moment|access denied|verify you are human/i.test(title);
  console.log(`bot-wall=${isCloudflareWall || (!hasLyricMarkup && /g-recaptcha|challenge-platform/.test(html))}`);
  const d1 = extractLyricsFromDataContainerHtml(html);
  const d2 = extractLyricsFromLegacyContainerHtml(html);
  const d3 = extractLyricsFromPreloadedState(html);
  console.log(`data-container=${d1 ? `OK (${d1.length} chars): ${JSON.stringify(d1.slice(0, 80))}` : 'null'}`);
  console.log(`legacy-container=${d2 ? `OK (${d2.length} chars): ${JSON.stringify(d2.slice(0, 80))}` : 'null'}`);
  console.log(`preloaded-state=${d3 ? `OK (${d3.length} chars): ${JSON.stringify(d3.slice(0, 80))}` : 'null'}`);
  const winner = d1 ?? d2 ?? d3;
  console.log(`LIVE_PAGE_CONFIRM=${winner ? 'OK' : 'FAILED_NONE'}`);
  process.exit(winner ? 0 : 1);
})().catch((err) => {
  console.log(`LIVE_PAGE_CONFIRM=FAILED_ERR: ${err?.message ?? err}`);
  process.exit(1);
});