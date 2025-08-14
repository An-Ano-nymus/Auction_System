// Automated API smoke test for Auction System
// Usage: node test_api.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const BASE = process.env.API_BASE || 'http://localhost:8080';
const TOKEN = process.env.TEST_TOKEN || '';
const HEADERS = TOKEN ? { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };

async function testHealth() {
  const res = await fetch(`${BASE}/health`);
  const data = await res.json();
  console.log('Health:', data);
}

async function testAuctions() {
  const res = await fetch(`${BASE}/api/auctions`);
  const data = await res.json();
  console.log('Auctions:', data.items.length);
  return data.items[0]?.id;
}

async function testCreateAuction() {
  const body = {
    title: 'Test Auction',
    startingPrice: 100,
    bidIncrement: 5,
    goLiveAt: new Date(Date.now() + 60000).toISOString(),
    durationMinutes: 10
  };
  const res = await fetch(`${BASE}/api/auctions`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body)
  });
  const data = await res.json();
  console.log('Create Auction:', data.id || data);
  return data.id;
}

async function testGetAuction(id) {
  const res = await fetch(`${BASE}/api/auctions/${id}`);
  const data = await res.json();
  console.log('Get Auction:', data.title || data);
}

async function testPlaceBid(id) {
  const body = { amount: 105 };
  const res = await fetch(`${BASE}/api/auctions/${id}/bids`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body)
  });
  const data = await res.json();
  console.log('Place Bid:', data.ok || data);
}

async function testEndAuction(id) {
  const res = await fetch(`${BASE}/api/auctions/${id}/end`, {
    method: 'POST', headers: HEADERS
  });
  const data = await res.json();
  console.log('End Auction:', data.ok || data);
}

async function testDecision(id) {
  const body = { action: 'accept' };
  const res = await fetch(`${BASE}/api/auctions/${id}/decision`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body)
  });
  const data = await res.json();
  console.log('Decision:', data.ok || data);
}

async function testNotifications() {
  const res = await fetch(`${BASE}/api/notifications`, { headers: HEADERS });
  const data = await res.json();
  console.log('Notifications:', data.items?.length || data);
}

(async () => {
  await testHealth();
  let auctionId = await testCreateAuction();
  await testGetAuction(auctionId);
  await testPlaceBid(auctionId);
  await testEndAuction(auctionId);
  await testDecision(auctionId);
  await testNotifications();
})();
