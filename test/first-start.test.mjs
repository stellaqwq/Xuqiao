import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareKernel } from '../src/qq/kernel/prepare.mjs';
import { config, temp } from './helpers.mjs';

async function fixture(t) {
  const root=await temp(t), runtime=join(root,'runtime','qq'), kernel=join(root,'runtime','kernel');
  const c=config(join(root,'data'),{QQ_DRIVER:'kernel',QQ_RUNTIME_DIR:runtime,QQ_KERNEL_DIR:kernel});
  return {root,runtime,kernel,c};
}
async function manifest(runtime) { await mkdir(runtime,{recursive:true});await writeFile(join(runtime,'runtime.json'),'{}'); }
async function ready(kernel,runtime,overrides={}) {
  await mkdir(kernel,{recursive:true});
  await writeFile(join(kernel,'adapter.json'),JSON.stringify({schema:1,runtime_root:resolve(runtime),host_sha256:'fixture-host',...overrides}));
  for(const name of ['wrapper.node','QQNT.dll'])await writeFile(join(kernel,name),'fixture');
}
test('fresh source without QQ gives first-run commands instead of adapter ENOENT and does not create a fake runtime',async t=>{
  const {root,runtime,c}=await fixture(t);
  await writeFile(join(root,'.env'),'# unchanged user configuration\n');
  await assert.rejects(prepareKernel(c,{discover(){throw Error('not installed');}}),error=>
    error.message.includes('qq:prepare')&&error.message.includes('qq:download -- --prepare --activate')&&!error.message.includes('ENOENT'));
  assert.equal(await readFile(join(root,'.env'),'utf8'),'# unchanged user configuration\n');
  await assert.rejects(readFile(join(runtime,'runtime.json')),{code:'ENOENT'});
});
test('first start prepares detected QQ then builds missing host into the configured paths',async t=>{
  const {runtime,kernel,c}=await fixture(t),calls=[];
  const result=await prepareKernel(c,{
    discover:()=>({executable:'fixture-QQ.exe'}),
    bundle:async options=>{calls.push(['bundle',options]);await manifest(runtime);},
    build:async options=>{calls.push(['build',options]);return {version:'fixture'};}
  });
  assert.equal(result.prepared,true);
  assert.deepEqual(calls,[['bundle',{source:'fixture-QQ.exe',destination:runtime}],['build',{runtimeDirectory:runtime,directory:kernel}]]);
});
test('an existing official runtime with no adapter is built without copying or downloading QQ',async t=>{
  const {runtime,kernel,c}=await fixture(t);await manifest(runtime);
  let builds=0;
  await prepareKernel(c,{discover(){throw Error('must not discover');},bundle(){throw Error('must not copy');},
    build:async options=>{builds++;assert.equal(options.directory,kernel);return {};}});
  assert.equal(builds,1);
});
test('moved projects and changed Node hosts rebuild while ready hosts are left intact',async t=>{
  const {runtime,kernel,c}=await fixture(t);await manifest(runtime);
  let builds=0;
  const options={fingerprint:async()=>'fixture-host',build:async()=>{builds++;return {};}};
  await ready(kernel,runtime);
  assert.equal((await prepareKernel(c,options)).prepared,false);assert.equal(builds,0);
  await ready(kernel,runtime,{runtime_root:join(runtime,'old-location')});
  assert.equal((await prepareKernel(c,options)).prepared,true);
  await ready(kernel,runtime,{host_sha256:'old-node'});
  assert.equal((await prepareKernel(c,options)).prepared,true);assert.equal(builds,2);
});
test('preparation rejects unsupported platforms and keeps build errors actionable',async t=>{
  const {runtime,c}=await fixture(t);await manifest(runtime);
  await assert.rejects(prepareKernel(c,{platform:'linux'}),/Windows x64/);
  await assert.rejects(prepareKernel(c,{build:async()=>{throw Error('fixture integrity failure');}}),/fixture integrity failure[\s\S]*qq:download/);
  assert.equal((await prepareKernel({...c,driver:'demo'},{platform:'linux'})).reason,'other_driver');
});
