import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { kernelHost } from './kernel-host-harness.mjs';
import { waitFor, withTestTimeout } from './helpers.mjs';

test('cold saved-session recovery waits for the login connection before reading credentials',async t=>{
  const host=await kernelHost(t,{loginConnectDelay:40});
  assert.equal(host.loginConnects,1);assert.equal(host.prematureLoginReads,0);
  assert.equal(host.inspect().login_waiters,0);
});

test('QR requests reconnect a disconnected login transport before requesting an image',async t=>{
  const host=await kernelHost(t);host.setAutoLoginConnect(false);host.loginDisconnected();
  const initial=host.loginConnects,request=host.request('auth.start');
  await waitFor(()=>host.loginConnects>initial);assert.equal(host.qrRequests,0);
  host.loginConnected();const response=await request.result;
  assert.equal(response.error,undefined);assert.equal(response.result.state,'waiting_scan');
  assert.equal(host.qrRequests,1);assert.equal(host.inspect().login_waiters,0);assert.equal(host.inspect().qr_waiters,0);
});

test('cancelling connection readiness resets QR state and releases listeners',async t=>{
  const host=await kernelHost(t);host.setAutoLoginConnect(false);host.loginDisconnected();
  const request=host.request('auth.start');await waitFor(()=>host.inspect().login_waiters===1);
  host.cancel(request.id);const response=await request.result;
  assert.equal(response.error.code,1502);assert.equal(host.inspect().state,'qr_failed');
  assert.equal(host.inspect().login_waiters,0);assert.equal(host.qrRequests,0);
  host.setAutoLoginConnect(true);assert.equal((await host.request('auth.start').result).result.state,'waiting_scan');
});

test('login connection timeout has a specific error and leaves QR acquisition retryable',async t=>{
  const host=await kernelHost(t);host.setAutoLoginConnect(false);host.loginDisconnected();
  const response=await host.request('auth.start').result;
  assert.equal(response.error.code,1502);assert.match(response.error.message,/登录服务器超时/);
  assert.equal(host.inspect().state,'qr_failed');assert.equal(host.inspect().login_waiters,0);
});

test('missing image callbacks time out explicitly instead of leaving requesting_qr stuck',async t=>{
  const host=await kernelHost(t);host.setQRResponse(()=>{});
  const response=await host.request('auth.start').result;
  assert.equal(response.error.code,1502);assert.match(response.error.message,/二维码获取超时/);
  assert.equal(host.inspect().state,'qr_failed');assert.equal(host.inspect().qr_waiters,0);
  host.qrPicture();assert.equal(host.inspect().state,'qr_failed','ignore an image arriving after its request ended');
  host.setQRResponse(undefined);
  assert.equal((await host.request('auth.start').result).result.state,'waiting_scan');
});

test('invalid PNG callbacks fail immediately and release the request',async t=>{
  const host=await kernelHost(t);host.setQRResponse(()=>host.qrPicture('bm90LWEtcG5n'));
  const response=await withTestTimeout(()=>host.request('auth.start').result,300);
  assert.equal(response.error.code,1500);assert.match(response.error.message,/图片无效/);
  assert.equal(host.inspect().state,'qr_failed');assert.equal(host.inspect().qr_waiters,0);
});

test('late QR polling events cannot mark an authenticated session offline',async t=>{
  const host=await kernelHost(t);await host.request('auth.start').result;
  host.authenticate();await waitFor(()=>host.inspect().online);
  host.qrScanned();host.qrFailed();host.qrPicture();await delay(30);
  assert.equal(host.inspect().state,'online');assert.equal(host.inspect().online,true);
});
