import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MockAgent } from 'undici';
import { PublicHttpFetchProvider, isPublicHttpAddress, resolvePublicHttpAddresses } from '../dist/public-http-fetch.js';

test('public HTTP address policy rejects special, mapped, local and reserved address ranges', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.1.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicHttpAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicHttpAddress(ip), true, ip);
});

test('connection lookup rejects mixed DNS answers and a private answer after a public resolution', async () => {
  const publicAnswer = [{ address: '1.1.1.1', family: 4 }];
  assert.deepEqual(await resolvePublicHttpAddresses('example.com', async () => publicAnswer), publicAnswer);
  await assert.rejects(resolvePublicHttpAddresses('example.com', async () => [{ address: '127.0.0.1', family: 4 }]), /not public/);
  await assert.rejects(resolvePublicHttpAddresses('example.com', async () => [...publicAnswer, { address: '::1', family: 6 }]), /not public/);
});

test('private URL spellings are rejected before any local connection', async t => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('must not be read'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const provider = new PublicHttpFetchProvider(); t.after(() => provider.dispose());
  const port = server.address().port;
  for (const host of ['127.0.0.1', '2130706433', '0x7f000001', 'localhost', '[::ffff:127.0.0.1]']) await assert.rejects(provider.fetch({ url: `http://${host}:${port}/` }), /public anonymous/);
  assert.equal(requests, 0);
});

test('public fetch keeps same-origin redirect, content and byte bounds and disposes safely', async t => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const pool = agent.get('https://example.com');
  pool.intercept({ path: '/start' }).reply(302, '', { headers: { location: '/text' } });
  pool.intercept({ path: '/text' }).reply(200, 'x'.repeat(18000), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  pool.intercept({ path: '/redirect' }).reply(302, '', { headers: { location: 'http://127.0.0.1/' } });
  pool.intercept({ path: '/large' }).reply(200, 'ignored', { headers: { 'content-type': 'text/plain', 'content-length': '262145' } });
  const provider = new PublicHttpFetchProvider(agent); t.after(() => provider.dispose());
  const result = await provider.fetch({ url: 'https://example.com/start' });
  assert.equal(result.url, 'https://example.com/text'); assert.equal(result.body.content.length, 16000); assert.equal(result.truncated, true);
  await assert.rejects(provider.fetch({ url: 'https://example.com/redirect' }), /public anonymous/);
  await assert.rejects(provider.fetch({ url: 'https://example.com/large' }), /byte limit/);
  await provider.dispose(); await assert.rejects(provider.fetch({ url: 'https://example.com/text' }));
});
