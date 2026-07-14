import 'dotenv/config';

async function test() {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  const { access_token } = await res.json();
  console.log('Token obtained:', !!access_token);

  // Test search
  const search = await fetch('https://api.spotify.com/v1/search?q=afrobeats&type=track&limit=3', {
    headers: { Authorization: 'Bearer ' + access_token },
  });
  console.log('Search status:', search.status);
  console.log('Search headers:', Object.fromEntries(search.headers.entries()));
  if (search.ok) {
    const text = await search.text();
    console.log('Search response length:', text.length);
    if (text.length > 0) {
      const searchData = JSON.parse(text);
      console.log('Tracks found:', searchData.tracks?.items?.length);
    }
  } else {
    console.log('Search error:', await search.text());
  }

  // Test playlist access
  const pl = await fetch('https://api.spotify.com/v1/playlists/37i9dQZF1DX70RN3TfWWJh/tracks?limit=3', {
    headers: { Authorization: 'Bearer ' + access_token },
  });
  console.log('Playlist status:', pl.status);
  if (pl.ok) {
    const text = await pl.text();
    console.log('Playlist response length:', text.length);
    if (text.length > 0) {
      const plData = JSON.parse(text);
      console.log('Playlist tracks:', plData.items?.length);
    }
  } else {
    console.log('Playlist error:', await pl.text());
  }
}

test();
