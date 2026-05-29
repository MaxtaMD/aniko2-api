const axios = require('axios');
const cheerio = require('cheerio');
async function test() {
  const url = 'https://anikototv.to/ajax/episode/list/8696';
  console.log('Fetching', url);
  try {
    const { data } = await axios.get(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    console.log(data.status, data.result?.substring(0, 500));
  } catch (err) {
    console.error('Failed', err.response?.status, err.response?.statusText);
  }
}
test().catch(console.error);
